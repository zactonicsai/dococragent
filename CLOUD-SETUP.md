# DocScan — Cloud Architecture Guide
## AWS & Azure Scalable Deployment with Failover & Load Balancing

> **Designed by:** Cloud Solution Architect
> **Base System:** DocScan (4 microservices — Gateway, API, OCR, Frontend)
> **Target:** Production-grade deployment with 2 instances, auto-failover, and load balancing

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Design Principles](#2-design-principles)
3. [Current Architecture Baseline](#3-current-architecture-baseline)
4. [Cloud-Ready Refactoring](#4-cloud-ready-refactoring)
5. [AWS Architecture](#5-aws-architecture)
6. [Azure Architecture](#6-azure-architecture)
7. [Failover Design Patterns](#7-failover-design-patterns)
8. [Load Balancing Deep Dive](#8-load-balancing-deep-dive)
9. [Shared Storage Architecture](#9-shared-storage-architecture)
10. [Container Orchestration](#10-container-orchestration)
11. [Networking & Security](#11-networking--security)
12. [Monitoring & Observability](#12-monitoring--observability)
13. [CI/CD Pipeline](#13-cicd-pipeline)
14. [Cost Estimation](#14-cost-estimation)
15. [Disaster Recovery](#15-disaster-recovery)
16. [AWS Infrastructure as Code (Terraform)](#16-aws-infrastructure-as-code)
17. [Azure Infrastructure as Code (Terraform)](#17-azure-infrastructure-as-code)
18. [Docker Compose for Cloud (ECS/ACI)](#18-docker-compose-for-cloud)
19. [Health Check & Auto-Recovery](#19-health-check--auto-recovery)
20. [Migration Checklist](#20-migration-checklist)

---

## 1. Executive Summary

This document transforms the DocScan local Docker Compose application into a **production-grade cloud deployment** on both AWS and Azure. The architecture provides:

| Requirement | Solution |
|-------------|----------|
| **2 Instances** | Each service runs 2 replicas across 2 Availability Zones |
| **Load Balancing** | Application Load Balancer (AWS ALB / Azure App Gateway) distributes traffic |
| **Failover** | If one instance dies, health checks detect it in <30s, traffic reroutes automatically |
| **Persistence** | Shared file storage (EFS / Azure Files) replaces Docker volumes |
| **Zero Downtime Deploys** | Rolling updates — one instance stays live while the other updates |
| **Auto-Recovery** | Container orchestrator restarts failed containers within 60 seconds |

---

## 2. Design Principles

### The Twelve-Factor App Alignment

| Factor | DocScan Implementation |
|--------|----------------------|
| **I. Codebase** | One repo, tracked in Git, multiple deploys (dev/staging/prod) |
| **II. Dependencies** | Explicitly declared in `package.json`, `requirements.txt`, `Dockerfile` |
| **III. Config** | Environment variables (`OCR_SERVICE_URL`, `API_KEY`) — never hardcoded |
| **IV. Backing Services** | OCR service treated as an attached resource (URL-based) |
| **V. Build/Release/Run** | Docker images built once, deployed to any environment |
| **VI. Processes** | Stateless processes — file state moved to shared storage |
| **VII. Port Binding** | Each service exports its own port |
| **VIII. Concurrency** | Scale out via container replicas (2 instances each) |
| **IX. Disposability** | Fast startup, graceful shutdown, crash-safe |
| **X. Dev/Prod Parity** | Same Docker images locally and in cloud |
| **XI. Logs** | Stdout/stderr → CloudWatch / Azure Monitor |
| **XII. Admin** | One-off tasks via `docker exec` or ECS Exec / ACI Exec |

### High Availability Targets

| Metric | Target | How |
|--------|--------|-----|
| **Uptime** | 99.9% (8.76h downtime/year) | Multi-AZ, health checks, auto-restart |
| **RTO** (Recovery Time Objective) | < 60 seconds | Orchestrator auto-replaces failed containers |
| **RPO** (Recovery Point Objective) | 0 (no data loss) | Shared persistent storage with replication |
| **Failover Time** | < 30 seconds | ALB health checks every 10s, 3 failures = reroute |

---

## 3. Current Architecture Baseline

### What We Have (Docker Compose — Single Host)

```
┌─────────────────────────────────────────────────────┐
│                   SINGLE HOST                        │
│                                                      │
│  ┌──────────┐ ┌──────────┐ ┌──────┐ ┌───────────┐  │
│  │ Frontend │ │ Gateway  │ │ API  │ │    OCR    │  │
│  │ (Nginx)  │ │ (Node)   │ │(Node)│ │ (Tesseract)│  │
│  │  :8080   │ │  :4000   │ │:3000 │ │   :5000   │  │
│  └──────────┘ └──────────┘ └──┬───┘ └───────────┘  │
│                                │                     │
│                         ┌──────▼──────┐              │
│                         │Docker Volume│              │
│                         │  /uploads   │              │
│                         └─────────────┘              │
│                                                      │
│  ⚠ Single Point of Failure                          │
│  ⚠ No redundancy                                    │
│  ⚠ Local disk = data loss if host fails             │
│  ⚠ No load balancing                                │
└─────────────────────────────────────────────────────┘
```

### Problems to Solve

| Problem | Risk | Cloud Solution |
|---------|------|---------------|
| Single host | Total outage if host dies | Multi-AZ deployment |
| Docker volume on local disk | Data loss | EFS / Azure Files |
| No health checks | Silent failures | ALB health probes + orchestrator checks |
| No load balancing | Can't handle traffic spikes | Application Load Balancer |
| Manual scaling | Slow response to demand | Auto-scaling policies |
| No monitoring | Blind to issues | CloudWatch / Azure Monitor |

---

## 4. Cloud-Ready Refactoring

### What Changes for Cloud

Before deploying to AWS or Azure, the following adjustments are needed:

#### 4.1 Stateless Services

The API service currently writes to a local Docker volume. In cloud, **both API instances must read/write the same storage**.

```
BEFORE (local):                 AFTER (cloud):
┌───────────────┐               ┌───────────────┐
│ API Instance  │               │ API Instance 1│──┐
│ Docker Volume │               └───────────────┘  │  ┌──────────────┐
│ /app/uploads  │               ┌───────────────┐  ├─►│  Shared NFS  │
└───────────────┘               │ API Instance 2│──┘  │  (EFS/Azure  │
                                └───────────────┘     │   Files)     │
                                                      └──────────────┘
```

**Change:** Mount EFS (AWS) or Azure Files (Azure) to `/app/uploads` on all API instances.

#### 4.2 Service Discovery

Docker Compose uses service names (`http://ocr:5000`). In cloud:

| Platform | Service Discovery Method |
|----------|------------------------|
| **AWS ECS** | CloudMap (DNS-based) — `ocr.docupload.local` |
| **AWS EKS** | Kubernetes DNS — `ocr-service.default.svc.cluster.local` |
| **Azure ACI** | Private DNS zones or sidecar discovery |
| **Azure AKS** | Kubernetes DNS |

**Change:** Replace hardcoded service names with environment variables that resolve via cloud DNS.

#### 4.3 Centralized Logging

```
BEFORE:  docker compose logs -f api
AFTER:   CloudWatch Logs / Azure Monitor Log Analytics
```

**Change:** Configure log drivers to ship stdout to cloud logging services.

#### 4.4 Health Endpoints

All services already have `/health` or `/api/health` endpoints. These become the targets for:
- **Load balancer health checks** (route traffic only to healthy instances)
- **Container orchestrator liveness probes** (restart unhealthy containers)

---

## 5. AWS Architecture

### 5.1 High-Level Architecture Diagram

```
                         ┌──────────────────────────────────────────────┐
                         │              AWS Region (us-east-1)          │
                         │                                              │
    Internet             │   ┌────────────────────────────────────┐    │
       │                 │   │        Application Load Balancer    │    │
       │                 │   │   ┌──────────┐    ┌──────────────┐ │    │
       └────────────────►│   │   │ :443/80  │    │ :4000        │ │    │
                         │   │   │ Frontend │    │ Gateway API  │ │    │
                         │   │   │ Listener │    │ Listener     │ │    │
                         │   │   └─────┬────┘    └──────┬───────┘ │    │
                         │   └─────────┼────────────────┼─────────┘    │
                         │             │                │              │
                         │   ┌─────────▼────────────────▼──────────┐   │
                         │   │          ECS Cluster (Fargate)       │   │
                         │   │                                      │   │
          ┌──────────────┼───┼───── Availability Zone A ────────┐  │   │
          │              │   │                                   │  │   │
          │  ┌─────────┐ │   │  ┌─────────┐ ┌──────┐ ┌───────┐│  │   │
          │  │Frontend-1│ │   │  │Gateway-1│ │API-1 │ │ OCR-1 ││  │   │
          │  │ (Nginx)  │ │   │  │ (Node)  │ │(Node)│ │(Tess.)││  │   │
          │  └─────────┘ │   │  └─────────┘ └──┬───┘ └───────┘│  │   │
          │              │   │                  │               │  │   │
          └──────────────┼───┼──────────────────┼───────────────┘  │   │
                         │   │                  │                   │   │
          ┌──────────────┼───┼───── Availability Zone B ────────┐  │   │
          │              │   │                  │                │  │   │
          │  ┌─────────┐ │   │  ┌─────────┐ ┌──▼───┐ ┌───────┐│  │   │
          │  │Frontend-2│ │   │  │Gateway-2│ │API-2 │ │ OCR-2 ││  │   │
          │  │ (Nginx)  │ │   │  │ (Node)  │ │(Node)│ │(Tess.)││  │   │
          │  └─────────┘ │   │  └─────────┘ └──┬───┘ └───────┘│  │   │
          │              │   │                  │               │  │   │
          └──────────────┼───┼──────────────────┼───────────────┘  │   │
                         │   │                  │                   │   │
                         │   └──────────────────┼───────────────────┘   │
                         │                      │                       │
                         │               ┌──────▼──────┐                │
                         │               │  Amazon EFS  │                │
                         │               │  /uploads    │                │
                         │               │ (Multi-AZ    │                │
                         │               │  replicated) │                │
                         │               └──────────────┘                │
                         │                                              │
                         │   ┌──────────┐  ┌──────────┐  ┌───────────┐ │
                         │   │CloudWatch│  │   ECR    │  │ CloudMap  │ │
                         │   │  Logs    │  │(Registry)│  │(Discovery)│ │
                         │   └──────────┘  └──────────┘  └───────────┘ │
                         └──────────────────────────────────────────────┘
```

### 5.2 AWS Services Used

| Service | Purpose | Why This Service |
|---------|---------|-----------------|
| **ECS Fargate** | Container orchestration (serverless) | No EC2 instances to manage; pay per vCPU/memory per second; built-in health checks and auto-restart |
| **ALB** (Application Load Balancer) | Layer 7 load balancing | Path-based routing (`/api/*` → API, `/v1/*` → Gateway); health checks; TLS termination; sticky sessions if needed |
| **ECR** (Elastic Container Registry) | Docker image storage | Private registry, integrated with ECS, vulnerability scanning |
| **EFS** (Elastic File System) | Shared persistent storage | NFS-compatible, multi-AZ, automatically scales, accessible from all Fargate tasks |
| **CloudMap** | Service discovery | DNS-based discovery so services find each other (`ocr.docupload.local`) |
| **CloudWatch** | Logging & monitoring | Centralized logs, metrics dashboards, alarms, auto-scaling triggers |
| **Route 53** | DNS management | Health-checked DNS failover, domain management |
| **ACM** | TLS certificates | Free auto-renewing certificates for HTTPS |
| **VPC** | Network isolation | Private subnets for services, public subnets for ALB only |
| **WAF** | Web application firewall | Rate limiting, IP blocking, SQL injection protection at the edge |

### 5.3 ECS Task Definitions

Each service becomes an **ECS Task Definition** with a **Service** that maintains the desired count (2).

```
┌─────────────────────────────────────────────────────────────────┐
│                    ECS Cluster: docupload-prod                   │
│                                                                  │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐  │
│  │ Service: frontend       │  │ Service: gateway              │  │
│  │ Desired Count: 2        │  │ Desired Count: 2              │  │
│  │ Task Def: frontend:3    │  │ Task Def: gateway:5           │  │
│  │ CPU: 256  Memory: 512   │  │ CPU: 512  Memory: 1024        │  │
│  │ Port: 80                │  │ Port: 4000                    │  │
│  │ Health: GET / (200)     │  │ Health: GET /v1/health (200)  │  │
│  │ Deploy: Rolling         │  │ Deploy: Rolling               │  │
│  └─────────────────────────┘  └──────────────────────────────┘  │
│                                                                  │
│  ┌─────────────────────────┐  ┌──────────────────────────────┐  │
│  │ Service: api            │  │ Service: ocr                  │  │
│  │ Desired Count: 2        │  │ Desired Count: 2              │  │
│  │ Task Def: api:7         │  │ Task Def: ocr:4               │  │
│  │ CPU: 512  Memory: 1024  │  │ CPU: 1024  Memory: 2048       │  │
│  │ Port: 3000              │  │ Port: 5000                    │  │
│  │ Health: GET /api/health │  │ Health: GET /health (200)     │  │
│  │ EFS Mount: /app/uploads │  │ Deploy: Rolling               │  │
│  │ Deploy: Rolling         │  │                               │  │
│  └─────────────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 5.4 Resource Sizing (2-Instance Deployment)

| Service | vCPU | Memory | Instances | Total vCPU | Total Memory |
|---------|------|--------|-----------|-----------|-------------|
| Frontend (Nginx) | 0.25 | 512 MB | 2 | 0.50 | 1 GB |
| Gateway (Node) | 0.50 | 1 GB | 2 | 1.00 | 2 GB |
| API (Node) | 0.50 | 1 GB | 2 | 1.00 | 2 GB |
| OCR (Tesseract) | 1.00 | 2 GB | 2 | 2.00 | 4 GB |
| **Total** | | | **8 tasks** | **4.50** | **9 GB** |

**Why OCR gets more resources:** Tesseract OCR is CPU-intensive (image processing, neural network inference). A single OCR operation on a 300 DPI image can consume 100-200MB RAM and saturate a core for 5-30 seconds.

---

## 6. Azure Architecture

### 6.1 High-Level Architecture Diagram

```
                         ┌──────────────────────────────────────────────┐
                         │          Azure Region (East US)              │
                         │                                              │
    Internet             │   ┌────────────────────────────────────┐    │
       │                 │   │      Azure Application Gateway     │    │
       │                 │   │         (Layer 7 LB + WAF)         │    │
       └────────────────►│   │   ┌──────────┐  ┌──────────────┐  │    │
                         │   │   │ Frontend │  │ Gateway API  │  │    │
                         │   │   │ Pool     │  │ Pool         │  │    │
                         │   │   └─────┬────┘  └──────┬───────┘  │    │
                         │   └─────────┼──────────────┼───────────┘    │
                         │             │              │                │
                         │   ┌─────────▼──────────────▼────────────┐   │
                         │   │    Azure Container Apps Environment  │   │
                         │   │       (or AKS Cluster)               │   │
                         │   │                                      │   │
          ┌──────────────┼───┼─── Availability Zone 1 ──────────┐  │   │
          │              │   │                                   │  │   │
          │  ┌─────────┐ │   │  ┌─────────┐ ┌──────┐ ┌───────┐│  │   │
          │  │Frontend-1│ │   │  │Gateway-1│ │API-1 │ │ OCR-1 ││  │   │
          │  └─────────┘ │   │  └─────────┘ └──┬───┘ └───────┘│  │   │
          │              │   │                  │               │  │   │
          └──────────────┼───┼──────────────────┼───────────────┘  │   │
                         │   │                  │                   │   │
          ┌──────────────┼───┼─── Availability Zone 2 ──────────┐  │   │
          │              │   │                  │                │  │   │
          │  ┌─────────┐ │   │  ┌─────────┐ ┌──▼───┐ ┌───────┐│  │   │
          │  │Frontend-2│ │   │  │Gateway-2│ │API-2 │ │ OCR-2 ││  │   │
          │  └─────────┘ │   │  └─────────┘ └──┬───┘ └───────┘│  │   │
          │              │   │                  │               │  │   │
          └──────────────┼───┼──────────────────┼───────────────┘  │   │
                         │   │                  │                   │   │
                         │   └──────────────────┼───────────────────┘   │
                         │                      │                       │
                         │               ┌──────▼──────┐                │
                         │               │ Azure Files  │                │
                         │               │ Premium SMB  │                │
                         │               │ (ZRS - Zone  │                │
                         │               │  Redundant)  │                │
                         │               └──────────────┘                │
                         │                                              │
                         │   ┌──────────┐  ┌──────────┐  ┌───────────┐ │
                         │   │ Monitor  │  │   ACR    │  │ Key Vault │ │
                         │   │Log Analyt│  │(Registry)│  │ (Secrets) │ │
                         │   └──────────┘  └──────────┘  └───────────┘ │
                         └──────────────────────────────────────────────┘
```

### 6.2 Azure Services Used

| Service | Purpose | Why This Service |
|---------|---------|-----------------|
| **Azure Container Apps** | Container orchestration (serverless) | Built on Kubernetes but fully managed; built-in scaling, revisions, traffic splitting; Dapr integration for service discovery |
| **Application Gateway v2** | Layer 7 load balancing + WAF | Path-based routing, TLS termination, built-in WAF, health probes, connection draining |
| **ACR** (Azure Container Registry) | Docker image storage | Private registry, geo-replication, vulnerability scanning, integrated with Container Apps |
| **Azure Files Premium** | Shared persistent storage | SMB/NFS, zone-redundant storage (ZRS), mountable in containers |
| **Azure Monitor** | Logging & monitoring | Log Analytics workspace, Kusto queries, dashboards, alerts |
| **Azure DNS** | DNS management | Zone-redundant, health-checked routing |
| **Key Vault** | Secret management | API keys, connection strings, TLS certificates — never in env vars |
| **VNet** | Network isolation | Private endpoints, NSGs, service endpoints |
| **Front Door** | Global load balancing (optional) | CDN, edge caching, global failover across regions |

### 6.3 Azure Container Apps Configuration

```
┌───────────────────────────────────────────────────────────────────┐
│          Container Apps Environment: docupload-prod               │
│          VNet: docupload-vnet (10.0.0.0/16)                      │
│                                                                   │
│  ┌─────────────────────────┐  ┌────────────────────────────────┐ │
│  │ App: frontend           │  │ App: gateway                    │ │
│  │ Min Replicas: 2         │  │ Min Replicas: 2                 │ │
│  │ Max Replicas: 4         │  │ Max Replicas: 6                 │ │
│  │ CPU: 0.25  RAM: 0.5Gi  │  │ CPU: 0.5   RAM: 1.0Gi          │ │
│  │ Ingress: External :80  │  │ Ingress: External :4000         │ │
│  │ Health: /  (200, 10s)  │  │ Health: /v1/health (200, 10s)   │ │
│  │ Scale: HTTP concurrent  │  │ Scale: HTTP concurrent          │ │
│  └─────────────────────────┘  └────────────────────────────────┘ │
│                                                                   │
│  ┌─────────────────────────┐  ┌────────────────────────────────┐ │
│  │ App: api                │  │ App: ocr                        │ │
│  │ Min Replicas: 2         │  │ Min Replicas: 2                 │ │
│  │ Max Replicas: 8         │  │ Max Replicas: 4                 │ │
│  │ CPU: 0.5   RAM: 1.0Gi  │  │ CPU: 1.0   RAM: 2.0Gi          │ │
│  │ Ingress: Internal :3000│  │ Ingress: Internal :5000         │ │
│  │ Health: /api/health     │  │ Health: /health (200, 15s)      │ │
│  │ Volume: azure-files     │  │ Scale: HTTP concurrent          │ │
│  │ Scale: HTTP concurrent  │  │                                 │ │
│  └─────────────────────────┘  └────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

---

## 7. Failover Design Patterns

### 7.1 Instance-Level Failover (Within a Region)

```
Normal Operation:                   Failover (Instance 1 Dies):

  ALB/App Gateway                     ALB/App Gateway
    │         │                         │         │
    ▼         ▼                         ✗         ▼
 ┌──────┐ ┌──────┐                  ┌──────┐ ┌──────┐
 │API-1 │ │API-2 │                  │API-1 │ │API-2 │
 │ (AZ-a)│ │(AZ-b)│                  │DEAD  │ │100%  │
 └──┬───┘ └──┬───┘                  └──────┘ └──┬───┘
    │         │                                   │
    ▼         ▼                                   ▼
 ┌──────────────┐                          ┌──────────────┐
 │ Shared Store │                          │ Shared Store │
 │ EFS / Azure  │                          │ EFS / Azure  │
 │ Files        │                          │ Files        │
 └──────────────┘                          └──────────────┘

 50/50 traffic split                   0/100 — all traffic to healthy instance
                                       Orchestrator spawns replacement in <60s
```

### 7.2 Failover Timeline

```
T+0s     Instance-1 crashes (process killed, OOM, node failure)
         │
T+10s    Health check #1 fails (ALB checks every 10s)
         │
T+20s    Health check #2 fails
         │
T+30s    Health check #3 fails → ALB marks Instance-1 as UNHEALTHY
         │                     → ALL traffic routed to Instance-2
         │
T+30s    ECS/Container Apps detects task stopped
         │                     → Schedules replacement task
         │
T+45s    New container image pulled, started
         │
T+60s    New Instance-1 passes health check → ALB adds it back
         │                                  → Traffic balanced 50/50 again
         │
         ▼ TOTAL IMPACT: ~30s of single-instance, 0s of full outage
```

### 7.3 Failover Configuration

**AWS ALB Health Check:**
```
Protocol:        HTTP
Path:            /api/health (API), /v1/health (Gateway), / (Frontend), /health (OCR)
Port:            Service port
Interval:        10 seconds
Timeout:         5 seconds
Healthy Threshold:   2 consecutive successes
Unhealthy Threshold: 3 consecutive failures
Success Codes:   200
```

**Azure App Gateway Health Probe:**
```
Protocol:        HTTP
Path:            Same as above
Interval:        10 seconds
Timeout:         30 seconds
Unhealthy Threshold: 3 failures
Match Status:    200-399
```

### 7.4 OCR-Specific Failover Considerations

OCR requests are **long-running** (5-60 seconds). Special handling is needed:

| Scenario | Problem | Solution |
|----------|---------|----------|
| OCR instance dies mid-processing | Request lost, user gets timeout | API retries OCR call once to the other instance |
| Both OCR instances busy | New requests queue or timeout | Increase OCR replicas to 3-4, or add request queue (SQS/Service Bus) |
| Large PDF (50+ pages) | Single request blocks an OCR worker for minutes | Add async processing: upload returns immediately, OCR runs in background, webhook/poll for completion |

**Async OCR Pattern (recommended for production):**

```
┌────────┐     ┌──────┐     ┌───────────┐     ┌───────┐     ┌───────────┐
│ Client │────►│ API  │────►│ SQS/Queue │────►│  OCR  │────►│  Storage  │
│        │     │      │     │           │     │Worker │     │ (EFS/Azure│
│        │◄────│      │◄────│           │◄────│       │     │  Files)   │
│        │     │Status│     │  Notify   │     │       │     │           │
└────────┘     └──────┘     └───────────┘     └───────┘     └───────────┘

1. Client uploads file → API stores original, returns {jobId, status: "processing"}
2. API puts OCR job on queue (SQS / Azure Service Bus)
3. OCR worker picks up job, processes, saves text
4. Client polls GET /v1/documents/{id}/status or receives webhook
```

---

## 8. Load Balancing Deep Dive

### 8.1 ALB Path-Based Routing (AWS)

```
                    Application Load Balancer
                    ┌───────────────────────────────────┐
                    │                                   │
  /*.html, /css,    │  Rule 1: /* (default)             │──► Frontend Target Group
  /js, /            │                                   │    (frontend-1, frontend-2)
                    │                                   │
  /v1/*             │  Rule 2: /v1/*                    │──► Gateway Target Group
                    │                                   │    (gateway-1, gateway-2)
                    │                                   │
  /api/*            │  Rule 3: /api/*                   │──► API Target Group
  (direct access)   │                                   │    (api-1, api-2)
                    └───────────────────────────────────┘
```

### 8.2 Load Balancing Algorithms

| Algorithm | When to Use | Our Choice |
|-----------|------------|------------|
| **Round Robin** | Equal-capacity instances, uniform requests | Frontend, Gateway |
| **Least Outstanding Requests** | Varying request durations | API (mixed fast/slow OCR) |
| **IP Hash** | Session affinity needed | Not needed (stateless) |
| **Weighted** | Canary deployments, gradual rollout | During deployments |

### 8.3 Connection Draining

When an instance is being removed (scale-in or deploy), active connections must complete:

```
T+0s    Deploy triggered → new task starting
T+5s    New task passes health check → added to ALB
T+5s    Old task marked for draining → ALB stops sending NEW requests
        │
        │  ┌──── Draining Window: 120 seconds ────┐
        │  │ Existing requests allowed to complete  │
        │  │ New requests go to other instances      │
        │  └─────────────────────────────────────────┘
        │
T+125s  Old task stopped (all connections closed or timeout)
```

**AWS:** `deregistration_delay.timeout_seconds = 120`
**Azure:** `Connection draining timeout = 120 seconds`

---

## 9. Shared Storage Architecture

### 9.1 AWS EFS (Elastic File System)

```
┌──────────────────────────────────────────────────────────────┐
│                    Amazon EFS                                 │
│                                                               │
│  ┌─────────────────┐        ┌─────────────────┐              │
│  │  Mount Target    │        │  Mount Target    │              │
│  │  (AZ-a)         │        │  (AZ-b)         │              │
│  │  10.0.1.x:2049  │        │  10.0.2.x:2049  │              │
│  └────────┬────────┘        └────────┬────────┘              │
│           │                          │                        │
│           ▼                          ▼                        │
│  ┌──────────────┐          ┌──────────────┐                   │
│  │ API-1 (AZ-a) │          │ API-2 (AZ-b) │                   │
│  │ /app/uploads  │◄────────►│ /app/uploads  │                   │
│  └──────────────┘          └──────────────┘                   │
│                                                               │
│  Performance Mode: General Purpose                            │
│  Throughput Mode:  Bursting (or Provisioned for high OCR)    │
│  Encryption:       At rest (AES-256) + In transit (TLS)      │
│  Backup:           AWS Backup, daily, 30-day retention       │
└──────────────────────────────────────────────────────────────┘
```

**EFS Performance for OCR Workloads:**

| Metric | General Purpose | Provisioned |
|--------|----------------|-------------|
| Latency | ~5ms (acceptable for file write after OCR) | ~2ms |
| Throughput | Burst up to 100 MB/s | Configurable (e.g., 50 MB/s sustained) |
| IOPS | Burst up to 7,000 | Up to 55,000 |
| Cost | ~$0.30/GB/month | ~$0.30/GB + $6/MB/s/month |

### 9.2 Azure Files Premium

```
┌──────────────────────────────────────────────────────────────┐
│              Azure Files Premium (ZRS)                         │
│                                                               │
│  Storage Account: docuploadprod                               │
│  Share: uploads  (100 GiB provisioned)                       │
│  Redundancy: ZRS (Zone-Redundant Storage)                    │
│                                                               │
│  ┌────────────────┐          ┌────────────────┐               │
│  │ API-1 (Zone 1) │          │ API-2 (Zone 2) │               │
│  │ /app/uploads   │◄────────►│ /app/uploads   │               │
│  │ (SMB mount)    │          │ (SMB mount)    │               │
│  └────────────────┘          └────────────────┘               │
│                                                               │
│  Performance: Baseline 1 IOPS/GiB + burst                    │
│  Throughput:  100 MiB/s per share                            │
│  Encryption:  At rest (AES-256) + In transit (SMB 3.0 enc)  │
│  Backup:      Azure Backup, daily snapshots                  │
└──────────────────────────────────────────────────────────────┘
```

---

## 10. Container Orchestration

### 10.1 AWS ECS Fargate vs Azure Container Apps

| Feature | AWS ECS Fargate | Azure Container Apps |
|---------|----------------|---------------------|
| **Abstraction** | Task definitions + services | Container App + revisions |
| **Scaling** | Application Auto Scaling | Built-in KEDA-based scaling |
| **Min instances** | 0 (scale to zero) or fixed | 0 or fixed |
| **Service discovery** | CloudMap (DNS) | Built-in (internal ingress) |
| **Volume mounts** | EFS, EBS (with Fargate) | Azure Files, emptyDir |
| **Rolling deploys** | Native (min/max healthy %) | Revision-based traffic splitting |
| **Cost** | Per vCPU-second + memory-second | Per vCPU-second + memory-second |
| **Logging** | CloudWatch Logs (awslogs driver) | Azure Monitor (built-in) |
| **Secret injection** | SSM Parameter Store / Secrets Manager | Key Vault references |

### 10.2 Rolling Deployment Strategy

```
Deployment Configuration:
  Minimum Healthy Percent: 100%   ← At least 2 instances always running
  Maximum Percent:         200%   ← Can temporarily have 4 instances

Step 1: Current State         Step 2: New Instances         Step 3: Drain Old
┌──────┐ ┌──────┐           ┌──────┐ ┌──────┐            ┌──────┐ ┌──────┐
│v1.0  │ │v1.0  │           │v1.0  │ │v1.0  │            │v1.1  │ │v1.1  │
│(live)│ │(live)│           │(live)│ │(live)│            │(live)│ │(live)│
└──────┘ └──────┘           └──────┘ └──────┘            └──────┘ └──────┘
                            ┌──────┐ ┌──────┐
                            │v1.1  │ │v1.1  │
                            │(start)│ │(start)│
                            └──────┘ └──────┘

2 instances (v1.0)          4 instances (2×v1.0 + 2×v1.1)   2 instances (v1.1)
Zero downtime throughout.
```

---

## 11. Networking & Security

### 11.1 VPC / VNet Design

```
┌─────────────────────────────────────────────────────────────┐
│  VPC / VNet: 10.0.0.0/16                                    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Public Subnet (10.0.0.0/24) — AZ-a                  │   │
│  │  • ALB / App Gateway                                  │   │
│  │  • NAT Gateway                                        │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Public Subnet (10.0.1.0/24) — AZ-b                  │   │
│  │  • ALB / App Gateway (multi-AZ)                       │   │
│  │  • NAT Gateway (redundancy)                           │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Private Subnet (10.0.10.0/24) — AZ-a                │   │
│  │  • Frontend-1, Gateway-1, API-1, OCR-1               │   │
│  │  • EFS Mount Target                                   │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  Private Subnet (10.0.11.0/24) — AZ-b                │   │
│  │  • Frontend-2, Gateway-2, API-2, OCR-2               │   │
│  │  • EFS Mount Target                                   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Security Groups / NSGs:                                     │
│  • ALB-SG:       Inbound 80/443 from 0.0.0.0/0             │
│  • Frontend-SG:  Inbound 80 from ALB-SG only               │
│  • Gateway-SG:   Inbound 4000 from ALB-SG only             │
│  • API-SG:       Inbound 3000 from Gateway-SG, Frontend-SG │
│  • OCR-SG:       Inbound 5000 from API-SG only             │
│  • EFS-SG:       Inbound 2049 from API-SG only             │
└─────────────────────────────────────────────────────────────┘
```

### 11.2 Security Layers

```
Internet
  │
  ▼
┌─────────────┐
│  WAF / DDoS │   Layer 1: Edge Protection
│  Protection  │   • Rate limiting (1000 req/min)
│  (Shield)   │   • Geo-blocking
│             │   • SQL injection / XSS rules
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  TLS 1.3    │   Layer 2: Encryption in Transit
│  (ACM/KV)   │   • Free auto-renewing certificates
│             │   • HTTPS only, redirect HTTP→HTTPS
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  ALB / App  │   Layer 3: Load Balancer
│  Gateway    │   • Only entry point to private network
│             │   • Access logs → S3 / Storage Account
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Private    │   Layer 4: Network Isolation
│  Subnets    │   • No public IPs on containers
│  + NSGs     │   • Inter-service traffic only
│             │   • Outbound via NAT Gateway
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  API Key +  │   Layer 5: Application Auth
│  Rate Limit │   • X-API-Key validation
│  (Gateway)  │   • 100 req/60s per key
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Secrets    │   Layer 6: Secret Management
│  Manager /  │   • API keys in SSM / Key Vault
│  Key Vault  │   • Injected at runtime, never in images
└─────────────┘
```

---

## 12. Monitoring & Observability

### 12.1 Metrics Dashboard

```
┌─────────────────────────────────────────────────────────────────────┐
│                    DocScan Operations Dashboard                      │
│                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐ │
│  │ ALB Request Rate │  │ Error Rate (5xx)│  │ Avg Response Time   │ │
│  │     ▁▃▅▇█▇▅▃▁   │  │     ▁▁▁▃▁▁▁▁▁  │  │     ▃▃▃▅▇▅▃▃▃     │ │
│  │   ~150 req/min   │  │     ~0.1%       │  │   Gateway: 45ms    │ │
│  │                   │  │                 │  │   API: 120ms       │ │
│  │                   │  │                 │  │   OCR: 8,200ms     │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘ │
│                                                                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐ │
│  │ Healthy Hosts   │  │ CPU Utilization  │  │ Memory Utilization  │ │
│  │  Frontend: 2/2  │  │  Frontend:  5%  │  │  Frontend:  15%    │ │
│  │  Gateway:  2/2  │  │  Gateway:  20%  │  │  Gateway:   30%    │ │
│  │  API:      2/2  │  │  API:      35%  │  │  API:       45%    │ │
│  │  OCR:      2/2  │  │  OCR:      70%  │  │  OCR:       60%    │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────────┘ │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │ OCR Processing Time (P50 / P95 / P99)                          │ │
│  │  Images:  2.1s / 8.5s / 15.2s                                 │ │
│  │  PDFs:    5.3s / 25.1s / 58.7s                                │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

### 12.2 Alerting Rules

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| **Instance Down** | Healthy hosts < 2 for any service | Critical | Page on-call, auto-restart |
| **High Error Rate** | 5xx rate > 5% for 5 minutes | High | Page on-call |
| **OCR Timeout** | OCR P95 latency > 60s | Medium | Scale OCR to 3 instances |
| **High CPU** | OCR CPU > 85% for 10 minutes | Medium | Scale OCR up |
| **Storage Full** | EFS/Azure Files > 80% capacity | High | Expand storage, archive old files |
| **Rate Limit Hit** | 429 responses > 50/min | Low | Review API key usage |
| **All Instances Down** | 0 healthy hosts for any service | Critical | Incident declared, auto-recovery |

---

## 13. CI/CD Pipeline

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Git Push│───►│  Build   │───►│  Test    │───►│  Push    │───►│  Deploy  │
│          │    │  Docker  │    │  Health  │    │  to ECR/ │    │  Rolling │
│  main    │    │  Images  │    │  + Smoke │    │  ACR     │    │  Update  │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
                                                                      │
                                                                ┌─────▼─────┐
                                                                │  Canary   │
                                                                │  10% → 50%│
                                                                │  → 100%   │
                                                                └───────────┘
```

**Pipeline Stages:**

1. **Build** — Build Docker images for all 4 services, tag with git SHA
2. **Test** — Run health check tests against each container
3. **Push** — Push images to ECR (AWS) or ACR (Azure)
4. **Deploy Staging** — Update staging environment, run smoke tests
5. **Deploy Production** — Rolling update, canary (10% → 100% over 15 min)
6. **Verify** — Check health endpoints, error rates, latency
7. **Rollback** — Automatic if error rate > 5% during canary

---

## 14. Cost Estimation

### 14.1 AWS Monthly Cost (2 Instances per Service)

| Resource | Spec | Monthly Cost |
|----------|------|-------------|
| **ECS Fargate** (Frontend × 2) | 0.25 vCPU, 512MB, 730h | ~$17 |
| **ECS Fargate** (Gateway × 2) | 0.50 vCPU, 1GB, 730h | ~$48 |
| **ECS Fargate** (API × 2) | 0.50 vCPU, 1GB, 730h | ~$48 |
| **ECS Fargate** (OCR × 2) | 1.00 vCPU, 2GB, 730h | ~$130 |
| **ALB** | 1 ALB + LCU hours | ~$25 |
| **EFS** | 50GB General Purpose | ~$15 |
| **ECR** | 5 images × 500MB | ~$3 |
| **CloudWatch** | Logs + metrics | ~$15 |
| **NAT Gateway** | 1 per AZ × 2 | ~$70 |
| **Data Transfer** | ~100GB out | ~$9 |
| **Route 53** | 1 hosted zone | ~$1 |
| **Total** | | **~$381/month** |

### 14.2 Azure Monthly Cost (2 Instances per Service)

| Resource | Spec | Monthly Cost |
|----------|------|-------------|
| **Container Apps** (Frontend × 2) | 0.25 vCPU, 0.5Gi, 730h | ~$22 |
| **Container Apps** (Gateway × 2) | 0.50 vCPU, 1.0Gi, 730h | ~$58 |
| **Container Apps** (API × 2) | 0.50 vCPU, 1.0Gi, 730h | ~$58 |
| **Container Apps** (OCR × 2) | 1.00 vCPU, 2.0Gi, 730h | ~$145 |
| **Application Gateway v2** | Standard_v2 + WAF | ~$180 |
| **Azure Files Premium** | 100 GiB ZRS | ~$17 |
| **ACR** | Basic tier | ~$5 |
| **Monitor + Log Analytics** | 5GB/day ingestion | ~$12 |
| **VNet + NAT Gateway** | 1 NAT | ~$35 |
| **Data Transfer** | ~100GB out | ~$9 |
| **Total** | | **~$541/month** |

> **Note:** Azure App Gateway v2 is more expensive than AWS ALB. Using Azure Front Door instead for simple load balancing can reduce this to ~$40/month, bringing total closer to AWS.

### 14.3 Cost Optimization Tips

| Strategy | Savings | Trade-off |
|----------|---------|-----------|
| **Spot/Preemptible for OCR** | ~70% on OCR compute | OCR tasks may be interrupted (use retry queue) |
| **Scale-to-zero non-prod** | ~60% on dev/staging | Cold start latency (~5-10s) |
| **Reserved pricing (1-year)** | ~30% on Fargate/Container Apps | Commitment required |
| **S3/Blob instead of EFS/Files** | ~80% on storage | Requires code change (SDK vs filesystem) |
| **Reduce NAT Gateway** | ~$35-70/month | Use VPC endpoints for ECR/CloudWatch |

---

## 15. Disaster Recovery

### 15.1 Multi-Region Architecture (Active-Passive)

```
                    ┌─────────────────────────────────────┐
                    │     Route 53 / Azure Front Door     │
                    │     (DNS Failover / Global LB)      │
                    └─────────┬───────────────┬───────────┘
                              │               │
                    ┌─────────▼─────┐ ┌───────▼─────────┐
                    │  us-east-1    │ │  us-west-2      │
                    │  (PRIMARY)    │ │  (STANDBY)      │
                    │               │ │                 │
                    │  ECS: Active  │ │  ECS: Scaled    │
                    │  2 instances  │ │  to 0 or 1      │
                    │               │ │                 │
                    │  EFS: Active  │ │  EFS: Replica   │
                    │               │ │  (DataSync)     │
                    └───────────────┘ └─────────────────┘

    Normal:    100% → us-east-1
    Failover:  Route 53 health check fails → 100% → us-west-2 (within 60s)
    Recovery:  Scale up us-west-2, investigate us-east-1
```

### 15.2 Backup Strategy

| Data | Backup Method | Frequency | Retention |
|------|--------------|-----------|-----------|
| **Uploaded files** (EFS/Azure Files) | AWS Backup / Azure Backup | Daily | 30 days |
| **Container images** (ECR/ACR) | Registry replication | On push | Last 10 versions |
| **Configuration** | Git repository | Every commit | Unlimited |
| **Secrets** | SSM/Key Vault versioning | On change | Last 5 versions |
| **Logs** | CloudWatch/Log Analytics | Continuous | 90 days |

---

## 16. AWS Infrastructure as Code (Terraform)

```hcl
# ═══════════════════════════════════════════════════════════════════
# AWS Terraform — DocScan 2-Instance Deployment
# File: aws/main.tf
# ═══════════════════════════════════════════════════════════════════

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = var.aws_region
}

# ─── Variables ───────────────────────────────────────────────────

variable "aws_region"      { default = "us-east-1" }
variable "environment"     { default = "prod" }
variable "app_name"        { default = "docupload" }
variable "api_key"         { default = "change-me-in-production" sensitive = true }

locals {
  name_prefix = "${var.app_name}-${var.environment}"
  azs         = ["${var.aws_region}a", "${var.aws_region}b"]
  
  services = {
    frontend = { cpu = 256,  memory = 512,  port = 80,   desired = 2, health_path = "/"           }
    gateway  = { cpu = 512,  memory = 1024, port = 4000, desired = 2, health_path = "/v1/health"  }
    api      = { cpu = 512,  memory = 1024, port = 3000, desired = 2, health_path = "/api/health" }
    ocr      = { cpu = 1024, memory = 2048, port = 5000, desired = 2, health_path = "/health"     }
  }
}

# ─── VPC ─────────────────────────────────────────────────────────

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = { Name = "${local.name_prefix}-vpc" }
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.${count.index}.0/24"
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true
  tags = { Name = "${local.name_prefix}-public-${count.index}" }
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.0.${count.index + 10}.0/24"
  availability_zone = local.azs[count.index]
  tags = { Name = "${local.name_prefix}-private-${count.index}" }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.name_prefix}-igw" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name_prefix}-nat-eip" }
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${local.name_prefix}-nat" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ─── Security Groups ────────────────────────────────────────────

resource "aws_security_group" "alb" {
  name_prefix = "${local.name_prefix}-alb-"
  vpc_id      = aws_vpc.main.id
  ingress { from_port = 80;  to_port = 80;  protocol = "tcp"; cidr_blocks = ["0.0.0.0/0"] }
  ingress { from_port = 443; to_port = 443; protocol = "tcp"; cidr_blocks = ["0.0.0.0/0"] }
  egress  { from_port = 0;   to_port = 0;   protocol = "-1";  cidr_blocks = ["0.0.0.0/0"] }
}

resource "aws_security_group" "services" {
  name_prefix = "${local.name_prefix}-svc-"
  vpc_id      = aws_vpc.main.id
  ingress { from_port = 0; to_port = 65535; protocol = "tcp"; security_groups = [aws_security_group.alb.id] }
  ingress { from_port = 0; to_port = 65535; protocol = "tcp"; self = true }
  egress  { from_port = 0; to_port = 0;     protocol = "-1";  cidr_blocks = ["0.0.0.0/0"] }
}

resource "aws_security_group" "efs" {
  name_prefix = "${local.name_prefix}-efs-"
  vpc_id      = aws_vpc.main.id
  ingress { from_port = 2049; to_port = 2049; protocol = "tcp"; security_groups = [aws_security_group.services.id] }
}

# ─── EFS (Shared Storage) ───────────────────────────────────────

resource "aws_efs_file_system" "uploads" {
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"
  tags = { Name = "${local.name_prefix}-uploads" }
}

resource "aws_efs_mount_target" "uploads" {
  count           = 2
  file_system_id  = aws_efs_file_system.uploads.id
  subnet_id       = aws_subnet.private[count.index].id
  security_groups = [aws_security_group.efs.id]
}

# ─── ECR Repositories ───────────────────────────────────────────

resource "aws_ecr_repository" "services" {
  for_each = local.services
  name     = "${local.name_prefix}-${each.key}"
  image_scanning_configuration { scan_on_push = true }
}

# ─── ECS Cluster ─────────────────────────────────────────────────

resource "aws_ecs_cluster" "main" {
  name = local.name_prefix
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ─── CloudMap Namespace (Service Discovery) ──────────────────────

resource "aws_service_discovery_private_dns_namespace" "main" {
  name = "${var.app_name}.local"
  vpc  = aws_vpc.main.id
}

# ─── ALB ─────────────────────────────────────────────────────────

resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.services["frontend"].arn
  }
}

resource "aws_lb_target_group" "services" {
  for_each    = local.services
  name        = "${local.name_prefix}-${each.key}"
  port        = each.value.port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = each.value.health_path
    interval            = 10
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    matcher             = "200"
  }

  deregistration_delay = 120
}

# ALB Routing Rules
resource "aws_lb_listener_rule" "gateway" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 10
  condition { path_pattern { values = ["/v1/*"] } }
  action { type = "forward"; target_group_arn = aws_lb_target_group.services["gateway"].arn }
}

resource "aws_lb_listener_rule" "api" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 20
  condition { path_pattern { values = ["/api/*"] } }
  action { type = "forward"; target_group_arn = aws_lb_target_group.services["api"].arn }
}

# ─── ECS Task Definitions + Services ────────────────────────────

resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.name_prefix}-ecs-exec"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_cloudwatch_log_group" "services" {
  for_each          = local.services
  name              = "/ecs/${local.name_prefix}/${each.key}"
  retention_in_days = 30
}

# ─── Outputs ─────────────────────────────────────────────────────

output "alb_dns"      { value = aws_lb.main.dns_name }
output "frontend_url" { value = "http://${aws_lb.main.dns_name}" }
output "gateway_url"  { value = "http://${aws_lb.main.dns_name}/v1/health" }
```

---

## 17. Azure Infrastructure as Code (Terraform)

```hcl
# ═══════════════════════════════════════════════════════════════════
# Azure Terraform — DocScan 2-Instance Deployment
# File: azure/main.tf
# ═══════════════════════════════════════════════════════════════════

terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.80" }
  }
}

provider "azurerm" {
  features {}
}

# ─── Variables ───────────────────────────────────────────────────

variable "location"    { default = "eastus" }
variable "environment" { default = "prod" }
variable "app_name"    { default = "docupload" }
variable "api_key"     { default = "change-me-in-production" sensitive = true }

locals {
  name_prefix = "${var.app_name}-${var.environment}"
  rg_name     = "${local.name_prefix}-rg"
}

# ─── Resource Group ──────────────────────────────────────────────

resource "azurerm_resource_group" "main" {
  name     = local.rg_name
  location = var.location
}

# ─── VNet ────────────────────────────────────────────────────────

resource "azurerm_virtual_network" "main" {
  name                = "${local.name_prefix}-vnet"
  address_space       = ["10.0.0.0/16"]
  location            = var.location
  resource_group_name = azurerm_resource_group.main.name
}

resource "azurerm_subnet" "container_apps" {
  name                 = "container-apps"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.0.10.0/23"]
}

# ─── Azure Container Registry ───────────────────────────────────

resource "azurerm_container_registry" "main" {
  name                = "${replace(local.name_prefix, "-", "")}acr"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  sku                 = "Basic"
  admin_enabled       = true
}

# ─── Azure Files (Shared Storage) ───────────────────────────────

resource "azurerm_storage_account" "main" {
  name                     = "${replace(local.name_prefix, "-", "")}stor"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = var.location
  account_tier             = "Premium"
  account_replication_type = "ZRS"
  account_kind             = "FileStorage"
}

resource "azurerm_storage_share" "uploads" {
  name                 = "uploads"
  storage_account_name = azurerm_storage_account.main.name
  quota                = 100  # GiB
}

# ─── Log Analytics ───────────────────────────────────────────────

resource "azurerm_log_analytics_workspace" "main" {
  name                = "${local.name_prefix}-logs"
  resource_group_name = azurerm_resource_group.main.name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

# ─── Container Apps Environment ──────────────────────────────────

resource "azurerm_container_app_environment" "main" {
  name                       = "${local.name_prefix}-env"
  location                   = var.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id   = azurerm_subnet.container_apps.id
}

resource "azurerm_container_app_environment_storage" "uploads" {
  name                         = "uploads"
  container_app_environment_id = azurerm_container_app_environment.main.id
  account_name                 = azurerm_storage_account.main.name
  share_name                   = azurerm_storage_share.uploads.name
  access_key                   = azurerm_storage_account.main.primary_access_key
  access_mode                  = "ReadWrite"
}

# ─── Container Apps ──────────────────────────────────────────────

resource "azurerm_container_app" "ocr" {
  name                         = "ocr"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  template {
    min_replicas = 2
    max_replicas = 4
    container {
      name   = "ocr"
      image  = "${azurerm_container_registry.main.login_server}/docupload-ocr:latest"
      cpu    = 1.0
      memory = "2Gi"
    }
  }

  ingress {
    target_port      = 5000
    external_enabled = false
    transport        = "http"
    traffic_weight { percentage = 100; latest_revision = true }
  }
}

resource "azurerm_container_app" "api" {
  name                         = "api"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  template {
    min_replicas = 2
    max_replicas = 8
    container {
      name   = "api"
      image  = "${azurerm_container_registry.main.login_server}/docupload-api:latest"
      cpu    = 0.5
      memory = "1Gi"
      env { name = "OCR_SERVICE_URL"; value = "https://${azurerm_container_app.ocr.ingress[0].fqdn}" }
      env { name = "UPLOAD_DIR";      value = "/app/uploads" }
      volume_mounts { name = "uploads"; mount_path = "/app/uploads" }
    }
    volume { name = "uploads"; storage_name = "uploads"; storage_type = "AzureFile" }
  }

  ingress {
    target_port      = 3000
    external_enabled = false
    transport        = "http"
    traffic_weight { percentage = 100; latest_revision = true }
  }
}

resource "azurerm_container_app" "gateway" {
  name                         = "gateway"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  template {
    min_replicas = 2
    max_replicas = 6
    container {
      name   = "gateway"
      image  = "${azurerm_container_registry.main.login_server}/docupload-gateway:latest"
      cpu    = 0.5
      memory = "1Gi"
      env { name = "API_BACKEND_URL"; value = "https://${azurerm_container_app.api.ingress[0].fqdn}" }
      env { name = "API_KEY";         value = var.api_key }
    }
  }

  ingress {
    target_port      = 4000
    external_enabled = true
    transport        = "http"
    traffic_weight { percentage = 100; latest_revision = true }
  }
}

resource "azurerm_container_app" "frontend" {
  name                         = "frontend"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"

  template {
    min_replicas = 2
    max_replicas = 4
    container {
      name   = "frontend"
      image  = "${azurerm_container_registry.main.login_server}/docupload-app:latest"
      cpu    = 0.25
      memory = "0.5Gi"
    }
  }

  ingress {
    target_port      = 80
    external_enabled = true
    transport        = "http"
    traffic_weight { percentage = 100; latest_revision = true }
  }
}

# ─── Outputs ─────────────────────────────────────────────────────

output "frontend_url" { value = "https://${azurerm_container_app.frontend.ingress[0].fqdn}" }
output "gateway_url"  { value = "https://${azurerm_container_app.gateway.ingress[0].fqdn}" }
output "acr_server"   { value = azurerm_container_registry.main.login_server }
```

---

## 18. Docker Compose for Cloud (ECS/ACI)

### Deploy Existing Compose to AWS ECS

AWS supports Docker Compose directly via the `ecs-cli` or `docker compose` with the ECS context:

```bash
# Install the Docker ECS integration
docker context create ecs myecscontext

# Deploy directly from docker-compose.yml
docker compose --context myecscontext up

# This creates:
#   • ECS Cluster (Fargate)
#   • CloudFormation stack
#   • CloudMap namespace
#   • Security groups
#   • Load balancer
```

### Deploy to Azure Container Instances

```bash
# Create ACI context
docker context create aci myacicontext

# Deploy
docker compose --context myacicontext up
```

---

## 19. Health Check & Auto-Recovery

### Health Check Chain

```
                    ALB / App Gateway
                    Health Probe (every 10s)
                           │
              ┌────────────┼────────────┐
              │            │            │
              ▼            ▼            ▼
         GET /        GET /v1/     GET /api/
         Frontend     health       health
         (200 OK)     Gateway      API
                      (200 OK)     (200 OK)
                                      │
                                      ▼
                                   GET /health
                                   OCR Service
                                   (200 OK + 
                                    tesseract version)
```

### Auto-Recovery Matrix

| Failure Type | Detection | Recovery | Time |
|-------------|-----------|----------|------|
| **Container crash** | ECS/Container Apps task health | Auto-restart same AZ | ~15s |
| **Instance unhealthy** | ALB health check (3 × 10s) | Remove from LB, replace | ~30s |
| **AZ failure** | Cross-AZ health checks | Other AZ handles 100% traffic | ~10s |
| **Region failure** | Route 53/Front Door health | DNS failover to standby region | ~60s |
| **Storage failure** | EFS/Azure Files built-in | ZRS replication handles automatically | ~0s |
| **Deployment failure** | Error rate spike during canary | Auto-rollback to previous revision | ~30s |

---

## 20. Migration Checklist

### Phase 1: Preparation (Week 1)

- [ ] Create AWS account / Azure subscription
- [ ] Set up Terraform state backend (S3 / Azure Storage)
- [ ] Create container registries (ECR / ACR)
- [ ] Build and push Docker images to registries
- [ ] Create VPC/VNet with proper subnets
- [ ] Set up shared storage (EFS / Azure Files)
- [ ] Store secrets in SSM / Key Vault

### Phase 2: Infrastructure (Week 2)

- [ ] Deploy Terraform (VPC, subnets, security groups, ALB)
- [ ] Create ECS cluster / Container Apps environment
- [ ] Deploy OCR service (2 instances) — test health endpoint
- [ ] Deploy API service (2 instances) — test with EFS mount
- [ ] Deploy Gateway service (2 instances) — test auth + routing
- [ ] Deploy Frontend service (2 instances) — test static serving
- [ ] Configure ALB routing rules (path-based)
- [ ] Verify cross-service communication

### Phase 3: Validation (Week 3)

- [ ] Upload test documents via Gateway API (curl/Postman)
- [ ] Verify OCR processing works across instances
- [ ] Verify shared storage (upload on instance-1, download on instance-2)
- [ ] **Failover test:** Kill one instance, verify traffic reroutes in <30s
- [ ] **Load test:** Simulate 50 concurrent uploads
- [ ] **Rolling deploy test:** Update one service, verify zero downtime
- [ ] Set up monitoring dashboards and alerts
- [ ] Configure CI/CD pipeline

### Phase 4: Go Live (Week 4)

- [ ] DNS cutover (Route 53 / Azure DNS)
- [ ] Enable HTTPS (ACM / Key Vault certificates)
- [ ] Enable WAF rules
- [ ] Monitor for 48 hours
- [ ] Decommission local Docker Compose (keep as dev environment)
- [ ] Document runbooks for on-call team

---

## Architecture Decision Records

### ADR-001: ECS Fargate over EKS / Container Apps over AKS

**Decision:** Use Fargate (AWS) / Container Apps (Azure) instead of Kubernetes.

**Rationale:** With only 4 services and 8 containers, Kubernetes is over-engineered. Fargate and Container Apps provide the same scaling, health checks, and rolling deploys with zero cluster management overhead. Migration to EKS/AKS remains straightforward if complexity grows.

### ADR-002: Shared Filesystem over Object Storage

**Decision:** Use EFS/Azure Files instead of S3/Blob Storage.

**Rationale:** The existing codebase uses `fs.readFileSync` and filesystem paths. EFS/Azure Files are NFS/SMB-compatible — they mount as a directory and require zero code changes. Object storage (S3/Blob) would require rewriting all file I/O to use SDKs.

### ADR-003: Single ALB over Service Mesh

**Decision:** Use one ALB with path-based routing instead of an Istio/Linkerd service mesh.

**Rationale:** Service mesh adds significant complexity (sidecars, mTLS, control plane). With only 4 services and internal communication via CloudMap DNS, the ALB provides sufficient routing, health checking, and TLS termination. Revisit if adding >10 services.

---

*Architecture designed for DocScan document processing platform — AWS and Azure multi-AZ deployment with 2-instance redundancy, automatic failover, and zero-downtime deployments.*