To run all the agents in docker, create anm image using the docker file and run that

```
git clone https://github.com/devashish234073/cloud-pc-templates-marketplace
cd cloud-pc-templates-marketplace
cd cloud-pc-templates
docker build -t cloud-pc-templates-agents .
docker run -p 3005-3050:3005-3050 -p 4200:4200 cloud-pc-templates-agents
```

OR RUN DIRECTLY FROM DOCKERHUB
```
docker run -p 3005-3050:3005-3050 -p 4200:4200 devashish234073/cloud-pc-templates-agents
```

<img width="1391" height="715" alt="image" src="https://github.com/user-attachments/assets/24c73b6f-1ce1-4adf-be7e-3e0a75dd382d" />

<img width="1764" height="829" alt="image" src="https://github.com/user-attachments/assets/aa1bb46b-0875-4e58-bb19-7362ea1de111" />

