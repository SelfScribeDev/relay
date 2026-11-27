# The Selfscribe relay in a container. It has no dependencies, so nothing is installed.
#   docker build -t selfscribe-relay .
#   docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 -e TRUST_PROXY=1 selfscribe-relay
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/v1/health > /dev/null || exit 1
CMD ["node", "src/node.js"]
