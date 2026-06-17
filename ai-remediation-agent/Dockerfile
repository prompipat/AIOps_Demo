FROM node:20-alpine

RUN apk add --no-cache docker-cli docker-cli-compose

WORKDIR /app

COPY package*.json ./

RUN npm install --production

COPY . .

EXPOSE 3003

CMD ["npm", "start"]
