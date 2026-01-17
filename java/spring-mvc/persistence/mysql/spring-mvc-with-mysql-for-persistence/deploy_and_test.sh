#!/bin/bash
set -e

# Configuration
JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64
TOMCAT_HOME=~/apache-tomcat-9.0.113
PROJECT_DIR=~/new/cloud-pc-templates/java-web
export JAVA_HOME

echo "Using JAVA_HOME: $JAVA_HOME"
chmod +x $TOMCAT_HOME/bin/*.sh


# 1. Build
cd $PROJECT_DIR
echo "Building project..."
mvn clean package -DskipTests

# 2. Copy MySQL Driver to Tomcat Lib (Required for JNDI)
echo "Copying MySQL driver to Tomcat lib..."
cp target/java-web/WEB-INF/lib/mysql-connector-*.jar $TOMCAT_HOME/lib/

# 3. Configure server.xml
SERVER_XML=$TOMCAT_HOME/conf/server.xml
if grep -q "jdbc/MyDS" "$SERVER_XML"; then
    echo "DataSource already configured in server.xml"
else
    echo "Configuring DataSource in server.xml..."
    cp "$SERVER_XML" "$SERVER_XML.bak"
    
    RESOURCE_XML='<Resource name="jdbc/MyDS" global="jdbc/MyDS" auth="Container" type="javax.sql.DataSource" driverClassName="com.mysql.cj.jdbc.Driver" url="jdbc:mysql://localhost:3306/mydb?createDatabaseIfNotExist=true&amp;allowPublicKeyRetrieval=true&amp;useSSL=false" username="root" password="root" maxTotal="20" maxIdle="10" maxWaitMillis="-1"/>'
    
    # Insert before </GlobalNamingResources> using Python to avoid sed escaping issues
    python3 -c "import sys; content = open('$SERVER_XML').read(); new_content = content.replace('</GlobalNamingResources>', '''$RESOURCE_XML''' + '\n    </GlobalNamingResources>'); open('$SERVER_XML', 'w').write(new_content)"

fi

# 4. Deploy Application
echo "Deploying WAR..."
rm -rf $TOMCAT_HOME/webapps/java-web*
cp target/java-web.war $TOMCAT_HOME/webapps/

# 5. Restart Tomcat
echo "Restarting Tomcat..."
$TOMCAT_HOME/bin/shutdown.sh || true
sleep 5
$TOMCAT_HOME/bin/startup.sh

# 6. Wait for startup
echo "Waiting for application to start..."
for i in {1..30}; do
    if curl -s http://localhost:8080/java-web/api/test | grep "Application is running"; then
        echo "Application started successfully!"
        break
    fi
    echo "Waiting..."
    sleep 2
done

# 7. Test Endpoints
echo "Running tests..."
echo "1. Test Endpoint:"
curl -v http://localhost:8080/java-web/api/test
echo -e "\n"

echo "2. Add Item:"
curl -X POST "http://localhost:8080/java-web/api/items?name=TestItem"
echo -e "\n"

echo "3. Get Items:"
curl -s http://localhost:8080/java-web/api/items
echo -e "\n"

echo "Done."
