FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install dependencies
RUN apt-get update && \
    apt-get install -y curl git unzip ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

# NEW: install Angular CLI during build
RUN npm install -g @angular/cli

WORKDIR /workspace

# Clone your repository
RUN git clone https://github.com/devashish234073/cloud-pc-templates-marketplace

# Expose agent ports
EXPOSE 3000-3100
EXPOSE 4200

CMD bash -c '\
cd /workspace/cloud-pc-templates-marketplace/JS-AGENTS && \

for file in *.js; do \
  if [ -f "$file" ]; then \

    if [ "$file" = "angularConnector.js" ]; then \
      echo "Detected angularConnector.js — setting up Angular project"; \

      if [ ! -d angular-app ]; then \
        ng new angular-app --defaults --skip-git; \
      fi; \

      if [ -f angularConnector.js ]; then \
        mv angularConnector.js angular-app/; \
      fi; \

      cd angular-app; \

      echo "Running angularConnector.js inside Angular project"; \
      node angularConnector.js & \

      cd ..; \
    else \
      echo "Starting: $file"; \
      node "$file" & \
    fi; \

  fi; \
done && \

for zip in *.zip; do \
  if [ -f "$zip" ]; then \
    echo "Processing zip: $zip"; \
    unzip -o "$zip" -d "${zip%.zip}" && \
    cd "${zip%.zip}" && \
    if [ -f package.json ]; then \
      npm install; \
      echo "Running npm start in: ${zip%.zip}"; \
      npm start & \
    fi; \
    cd ..; \
  fi; \
done && \
wait'