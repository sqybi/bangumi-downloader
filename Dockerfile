FROM node:18-alpine

WORKDIR /root
ENV LANG C.UTF-8
ENV LC_ALL C.UTF-8

WORKDIR /root/frontend
COPY frontend /root/frontend

# Link data folder
RUN ln -s /data /root/frontend/database

# Install npm dependencies
RUN npm install

CMD ["node", "/root/frontend/index.js"]
EXPOSE 80