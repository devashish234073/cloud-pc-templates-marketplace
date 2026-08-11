FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && \
    apt-get install -y curl git unzip ca-certificates mysql-server openjdk-17-jdk-headless maven && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

# NEW: install Angular CLI during build
RUN npm install -g @angular/cli

# Create MySQL user and database during build
RUN service mysql start && \
    sleep 3 && \
    mysql -e "CREATE USER IF NOT EXISTS 'devas'@'localhost' IDENTIFIED BY 'devas123';" && \
    mysql -e "GRANT ALL PRIVILEGES ON *.* TO 'devas'@'localhost' WITH GRANT OPTION;" && \
    mysql -e "CREATE DATABASE IF NOT EXISTS cloud_pc_templates_agent;" && \
    mysql -e "FLUSH PRIVILEGES;"

WORKDIR /workspace

# Clone your repository
RUN git clone https://github.com/devashish234073/cloud-pc-templates-marketplace

# Expose agent ports
EXPOSE 3000-3100
EXPOSE 4200

CMD bash -c '\
cd /workspace/cloud-pc-templates-marketplace/cloud-pc-templates && ls && sed -i "s/\bsudo\b//g" setup_and_run.sh && ./setup_and_run.sh && wait'
