# syntax=docker/dockerfile:1.6
FROM node:20-alpine

ARG BEE_SLACK_PACKAGE=@jobmatchme/bee-slack

RUN apk add --no-cache \
    ca-certificates \
    tini

RUN addgroup -g 10001 -S app && adduser -S -D -H -u 10001 -G app -h /workspace app

RUN npm install -g --ignore-scripts "${BEE_SLACK_PACKAGE}"

WORKDIR /workspace
RUN mkdir -p /config && chown -R 10001:10001 /workspace /config

USER 10001:10001

ENV HOME=/workspace
ENV NODE_ENV=production
ENV BEE_SLACK_CONFIG=/config/config.json
ENV NODE_PATH=/usr/local/lib/node_modules/@jobmatchme/bee-slack/node_modules

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-lc", "bee-slack ${BEE_SLACK_CONFIG}"]
