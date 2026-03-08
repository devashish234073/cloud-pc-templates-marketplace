To run all the agents in docker, create anm image using the docker file and run that

```
git clone https://github.com/devashish234073/cloud-pc-templates-marketplace
cd cloud-pc-templates-marketplace
cd cloud-pc-templates
docker build -t cloud-pc-templates-agents .
docker run -p 3005-3050:3005-3050 -p 4200:4200 cloud-pc-templates-agents
```