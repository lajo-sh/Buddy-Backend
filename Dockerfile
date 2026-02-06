FROM node:krypton-alpine

COPY . /data
WORKDIR /data

RUN ["npm", "i", "-g", "pnpm"]

RUN ["pnpm", "install"]

RUN ["pnpm", "build"]

ENV NODE_ENV=production

CMD ["node", "dist/src/index.js"]
