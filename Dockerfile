FROM node:20-slim
WORKDIR /srv
COPY index.html ./
COPY app/server.js app/shim.js ./app/
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "app/server.js"]
