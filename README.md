# Node.js E-Commerce Microservices

A microservices-based e-commerce application built with Node.js, Express, MongoDB, and RabbitMQ.

## Architecture

![alt text](image.png)


## Prerequisites

- Node.js (v16+)
- Docker & Docker Compose
- MongoDB Atlas Account

---

## Environment Setup

Create `.env` files for each service:

**./auth/.env**
```
MONGODB_AUTH_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/auth_db
JWT_SECRET=your_jwt_secret
```

**./product/.env**
```
MONGODB_AUTH_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/auth_db
JWT_SECRET=your_jwt_secret
MONGODB_PRODUCT_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/product_db
```

**./order/.env**
```
MONGODB_AUTH_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/auth_db
JWT_SECRET=your_jwt_secret
MONGODB_PRODUCT_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/product_db
MONGODB_ORDER_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/order_db
```

---

## Running Locally

### Using Docker Compose

```bash
# Start all services
docker-compose up --build

# Stop all services
docker-compose down
```



---

## API Endpoints

All requests go through the **API Gateway** at `http://localhost:3003`

### Auth Service

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `http://localhost:3003/auth/register` | Register new user | No |
| POST | `http://localhost:3003/auth/login` | Login and get JWT token | No |
| GET | `http://localhost:3003/auth/dashboard` | Access dashboard | Yes |

### Product Service

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| GET | `http://localhost:3003/products/api/products` | Get all products | Yes |
| POST | `http://localhost:3003/products/api/products` | Create new product | Yes |
| POST | `http://localhost:3003/products/api/products/buy` | Buy products (creates order) | Yes |

---

## API Usage Examples

### 1. Register a User

```bash
curl -X POST http://localhost:3003/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "email": "test@example.com",
    "password": "password123"
  }'
```

### 2. Login

```bash
curl -X POST http://localhost:3003/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "password123"
  }'
```

**Response:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 3. Create a Product

```bash
curl -X POST http://localhost:3003/products/api/products \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "name": "iPhone 15",
    "price": 999,
    "description": "Latest Apple iPhone"
  }'
```

### 4. Get All Products

```bash
curl -X GET http://localhost:3003/products/api/products \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>"
```

### 5. Buy Products

```bash
curl -X POST http://localhost:3003/products/api/products/buy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_JWT_TOKEN>" \
  -d '{
    "productIds": ["product_id_1", "product_id_2"]
  }'
```

---

## Service Ports

| Service | Port |
|---------|------|
| Auth | 3000 |
| Product | 3001 |
| Order | 3002 |
| API Gateway | 3003 |
| RabbitMQ | 5672 |
| RabbitMQ UI | 15672 |

---

## Testing

```bash
npm test
```

---

## Kubernetes Deployment

See [k8s/README.md](./k8s/README.md) and [AWS_DEPLOYMENT.md](./AWS_DEPLOYMENT.md) for deployment instructions.
