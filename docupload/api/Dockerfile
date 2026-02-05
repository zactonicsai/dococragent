FROM node:18-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
RUN mkdir -p /app/uploads/originals /app/uploads/text

EXPOSE 3000
CMD ["npm", "start"]
