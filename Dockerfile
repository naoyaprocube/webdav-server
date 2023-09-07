FROM node:18
ENV NODE_OPTIONS --openssl-legacy-provider
RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app/
COPY ./package.json .
RUN npm install
COPY . .
RUN npm run build
CMD ["npx","node","/usr/src/app/index.js"]