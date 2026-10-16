# Despliegue bot-wsp en AWS (ECS Fargate)

## Requisitos previos
- AWS CLI configurado (`aws configure`)
- Región definida (ejemplo: `us-east-1`)
- VPC con al menos 2 subnets públicas o privadas con NAT Gateway

---

## Paso 1: Crear repositorio ECR

```bash
aws ecr create-repository \
  --repository-name bot-wsp \
  --image-scanning-configuration scanOnPush=true
```

Guarda el `repositoryUri` que devuelve (ej: `123456789.dkr.ecr.us-east-1.amazonaws.com/bot-wsp`).

---

## Paso 2: Guardar secretos en Secrets Manager

```bash
aws secretsmanager create-secret \
  --name bot-wsp/imap \
  --secret-string '{"IMAP_USER":"tu-correo@outlook.com","IMAP_PASS":"tu-contraseña"}'
```

Guarda el ARN que devuelve — lo necesitas para el task definition.

---

## Paso 3: Crear sistema de archivos EFS

EFS persiste la carpeta `/app/auth` (sesión de WhatsApp) entre deploys.

```bash
# Crear el file system
aws efs create-file-system \
  --performance-mode generalPurpose \
  --throughput-mode bursting \
  --tags Key=Name,Value=bot-wsp-auth

# Guarda el FileSystemId (ej: fs-0abc1234)

# Crear mount targets en cada subnet donde correrá ECS
aws efs create-mount-target \
  --file-system-id fs-0abc1234 \
  --subnet-id subnet-XXXXXXXX \
  --security-groups sg-XXXXXXXX
```

> El security group del mount target debe permitir NFS (puerto 2049) desde el security group de ECS.

---

## Paso 4: Crear roles IAM

### 4a. Task Execution Role (para que ECS pueda bajar imágenes y leer secretos)

```bash
aws iam create-role \
  --role-name ecsTaskExecutionRole \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }'

aws iam attach-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
```

Agrega permiso para Secrets Manager:

```bash
aws iam put-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-name SecretsAccess \
  --policy-document '{
    "Version":"2012-10-17",
    "Statement":[{
      "Effect":"Allow",
      "Action":["secretsmanager:GetSecretValue"],
      "Resource":"arn:aws:secretsmanager:*:*:secret:bot-wsp/*"
    }]
  }'
```

### 4b. Task Role (permisos del contenedor en runtime — mínimo por ahora)

```bash
aws iam create-role \
  --role-name ecsTaskRole \
  --assume-role-policy-document '{
    "Version":"2012-10-17",
    "Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]
  }'
```

---

## Paso 5: Crear log group en CloudWatch

```bash
aws logs create-log-group --log-group-name /ecs/bot-wsp
```

---

## Paso 6: Crear cluster ECS

```bash
aws ecs create-cluster --cluster-name bot-wsp-cluster
```

---

## Paso 7: Actualizar y registrar el Task Definition

Edita `ecs-task-definition.json` y reemplaza los placeholders:
- `<AWS_ACCOUNT_ID>` → tu account ID (ej: `123456789012`)
- `<REGION>` → tu región (ej: `us-east-1`)
- `<EFS_FILE_SYSTEM_ID>` → el ID de EFS del paso 3 (ej: `fs-0abc1234`)
- Los ARN de secrets con el sufijo real que devolvió Secrets Manager

```bash
aws ecs register-task-definition --cli-input-json file://ecs-task-definition.json
```

---

## Paso 8: Crear Security Group para el servicio ECS

```bash
aws ec2 create-security-group \
  --group-name bot-wsp-sg \
  --description "Bot WSP ECS Service" \
  --vpc-id vpc-XXXXXXXX

# Permitir tráfico al puerto 3000
aws ec2 authorize-security-group-ingress \
  --group-id sg-XXXXXXXX \
  --protocol tcp \
  --port 3000 \
  --cidr 0.0.0.0/0

# Permitir NFS hacia EFS (si no lo hiciste antes)
aws ec2 authorize-security-group-ingress \
  --group-id sg-EFS-XXXXXXXX \
  --protocol tcp \
  --port 2049 \
  --source-group sg-ECS-XXXXXXXX
```

---

## Paso 9: Crear servicio ECS

```bash
aws ecs create-service \
  --cluster bot-wsp-cluster \
  --service-name bot-wsp-service \
  --task-definition bot-wsp \
  --desired-count 1 \
  --launch-type FARGATE \
  --platform-version LATEST \
  --network-configuration '{
    "awsvpcConfiguration": {
      "subnets": ["subnet-XXXXXXXX", "subnet-YYYYYYYY"],
      "securityGroups": ["sg-XXXXXXXX"],
      "assignPublicIp": "ENABLED"
    }
  }'
```

> **Importante**: `desired-count: 1` — solo una instancia para evitar conflictos con la sesión de WhatsApp.

---

## Paso 10: Crear CodePipeline

### 10a. Crear rol de servicio para CodeBuild

Desde la consola AWS, al crear el proyecto de CodeBuild se crea automáticamente.

### 10b. Crear proyecto CodeBuild (consola)

1. **Source**: GitHub → selecciona `controloperacionalprize-boss/bot-wsp`
2. **Environment**:
   - Managed image → Amazon Linux 2 → Standard → `aws/codebuild/amazonlinux2-x86_64-standard:5.0`
   - **Privilegiado**: ✅ (necesario para Docker)
   - Informática: **3 GB / 2 vCPU** (suficiente)
3. **Variables de entorno**:
   - `AWS_ACCOUNT_ID` = tu account ID
   - `AWS_DEFAULT_REGION` = tu región
   - `IMAGE_REPO_NAME` = `bot-wsp`
   - `CONTAINER_NAME` = `bot-wsp`
4. **Buildspec**: usar el archivo `buildspec.yml` del repo

### 10c. Crear pipeline (consola)

1. **Source stage**: GitHub (v2) → repo `bot-wsp` → branch `main`
2. **Build stage**: el proyecto CodeBuild del paso anterior
3. **Deploy stage**: Amazon ECS → cluster `bot-wsp-cluster` → service `bot-wsp-service`

El archivo `imagedefinitions.json` que genera el buildspec le dice a ECS qué imagen usar.

---

## Verificación

```bash
# Ver tareas corriendo
aws ecs list-tasks --cluster bot-wsp-cluster --service-name bot-wsp-service

# Ver logs
aws logs tail /ecs/bot-wsp --follow

# Obtener IP pública de la tarea
TASK_ARN=$(aws ecs list-tasks --cluster bot-wsp-cluster --query 'taskArns[0]' --output text)
ENI_ID=$(aws ecs describe-tasks --cluster bot-wsp-cluster --tasks $TASK_ARN \
  --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text)
aws ec2 describe-network-interfaces --network-interface-ids $ENI_ID \
  --query 'NetworkInterfaces[0].Association.PublicIp' --output text
```

Luego accede a `http://<IP>:3000/health` para verificar y `http://<IP>:3000/sessions/<id>/qr` para escanear el QR de WhatsApp.
