# Onion Flows API Documentation

## Overview

Onion Flows is a multi-tenant chatbot platform built with Node.js, Express, and MongoDB. It provides RESTful APIs for managing chatbots, flows, users, and analytics across multiple tenants.

### Tech Stack

- **Runtime**: Node.js 22+
- **Framework**: Express.js 5.x
- **Database**: MongoDB with native driver
- **Real-time**: Socket.IO
- **Authentication**: JWT (jsonwebtoken)
- **Validation**: Zod
- **Security**: bcrypt, cors, express-rate-limit

### Base URL

```
http://localhost:3001
```

---

## Authentication

All protected endpoints require a Bearer token in the Authorization header.

```
Authorization: Bearer <token>
```

### Login

**Endpoint**: `POST /api/auth/login`

**Request Body**:
```json
{
  "username": "string",
  "password": "string"
}
```

**Response** (200):
```json
{
  "user": {
    "id": "string",
    "name": "string",
    "username": "string",
    "role": "SUPER_ADMIN | ADMIN | MANAGER | AGENT",
    "tenantId": "string"
  },
  "token": "string"
}
```

**Errors**:
- 400: Validation error
- 401: Invalid credentials

### Heartbeat

**Endpoint**: `GET /api/auth/heartbeat`

**Required**: Bearer token

**Response** (200):
```json
{
  "valid": true,
  "user": {
    "id": "string",
    "name": "string",
    "username": "string",
    "role": "string",
    "tenantId": "string"
  }
}
```

---

## Authorization

### Roles Hierarchy

| Role | Permissions |
|------|-------------|
| SUPER_ADMIN | Full system access across all tenants |
| ADMIN | Full tenant access |
| MANAGER | Flow and content management |
| AGENT | Chat participation only |

### Role-Based Access

Endpoints declare required roles in middleware. SUPER_ADMIN bypasses tenant isolation.

---

## Tenants

### List Tenants

**Endpoint**: `GET /api/tenants`

**Response** (200):
```json
[
  {
    "id": "tenant_123",
    "name": "Company Name",
    "plan": "free | basic | pro",
    "status": "active | trial | suspended",
    "createdAt": "ISO8601"
  }
]
```

### Create Tenant

**Endpoint**: `POST /api/tenants`

**Required**: Authentication

**Request Body**:
```json
{
  "name": "string",
  "plan": "free | basic | pro"
}
```

### Tenant Users

**Endpoint**: `GET /api/tenants/:tenantId/users`

**Required**: Authentication

### Tenant Analytics

**Endpoint**: `GET /api/tenants/:tenantId/analytics`

**Required**: SUPER_ADMIN or same tenant

**Response** (200):
```json
{
  "tenantId": "string",
  "tenantName": "string",
  "generatedAt": "ISO8601",
  "agents": {
    "total": 10,
    "online": 5,
    "offline": 5,
    "byRole": {
      "admins": 2,
      "managers": 3,
      "agents": 5
    },
    "details": [...]
  },
  "chats": {
    "total": 100,
    "today": 25,
    "active": 15,
    "waiting": 5,
    "closed": 80,
    "byStatus": {...}
  },
  "queues": {
    "total": 3,
    "details": [...]
  },
  "metrics": {
    "averageResponseTime": 30,
    "satisfactionRate": 85,
    "resolutionRate": 75
  }
}
```

### Tenant Chats

**Endpoint**: `GET /api/tenants/:tenantId/chats`

**Required**: SUPER_ADMIN or same tenant

### Switch Tenant

**Endpoint**: `POST /api/tenants/:tenantId/switch`

**Required**: SUPER_ADMIN

### Current Tenant

**Endpoint**: `GET /api/tenants/tenant/current`

---

## Users

### List Users

**Endpoint**: `GET /api/users`

**Required**: Authentication, valid tenant

**Response** (200):
```json
[
  {
    "id": "u_123",
    "name": "User Name",
    "username": "username",
    "role": "ADMIN | MANAGER | AGENT",
    "tenantId": "tenant_123",
    "queues": ["q_1", "q_2"],
    "createdAt": "ISO8601"
  }
]
```

### Create User

**Endpoint**: `POST /api/users`

**Required**: Authentication, ADMIN or SUPER_ADMIN role

**Request Body**:
```json
{
  "username": "string (min 3 chars)",
  "password": "string (min 6 chars)",
  "name": "string",
  "role": "ADMIN | MANAGER | AGENT",
  "queues": ["queue_id_1", "queue_id_2"],
  "tenantId": "string (SUPER_ADMIN only)"
}
```

### Delete User

**Endpoint**: `DELETE /api/users/:id`

**Required**: Authentication, ADMIN or SUPER_ADMIN role

---

## Flows

### List Flows

**Endpoint**: `GET /api/flows`

**Required**: Authentication, valid tenant

**Response** (200):
```json
[
  {
    "id": "f_123",
    "name": "Welcome Flow",
    "description": "Initial greeting flow",
    "status": "draft | published",
    "version": 1,
    "tenantId": "tenant_123",
    "createdAt": "ISO8601"
  }
]
```

### Get Flow

**Endpoint**: `GET /api/flows/:id`

**Required**: Authentication

### Create Flow

**Endpoint**: `POST /api/flows`

**Required**: Authentication, ADMIN, MANAGER, or SUPER_ADMIN

**Request Body**:
```json
{
  "name": "string",
  "description": "string (optional)",
  "nodes": [...],
  "edges": [...]
}
```

### Update Flow

**Endpoint**: `PUT /api/flows/:id`

**Required**: Authentication, ADMIN, MANAGER, or SUPER_ADMIN

**Request Body**:
```json
{
  "name": "string",
  "description": "string",
  "nodes": [...],
  "edges": [...],
  "status": "draft | published"
}
```

### Delete Flow

**Endpoint**: `DELETE /api/flows/:id`

**Required**: Authentication, ADMIN, MANAGER, or SUPER_ADMIN

---

## Variables

### List Variables

**Endpoint**: `GET /api/variables`

**Required**: Authentication, valid tenant

### Create Variable

**Endpoint**: `POST /api/variables`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

**Request Body**:
```json
{
  "name": "string",
  "type": "text | number | boolean | json",
  "defaultValue": "any",
  "description": "string"
}
```

### Update Variable

**Endpoint**: `PUT /api/variables/:id`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

### Delete Variable

**Endpoint**: `DELETE /api/variables/:id`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

---

## Templates

### List Templates

**Endpoint**: `GET /api/templates`

**Required**: Authentication, valid tenant

### Create Template

**Endpoint**: `POST /api/templates`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

**Request Body**:
```json
{
  "name": "string",
  "text": "string",
  "buttons": [
    {
      "id": "string",
      "label": "string",
      "nextNodeId": "string (optional)"
    }
  ]
}
```

### Delete Template

**Endpoint**: `DELETE /api/templates/:id`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

---

## Schedules

### List Schedules

**Endpoint**: `GET /api/schedules`

**Required**: Authentication, valid tenant

### Create Schedule

**Endpoint**: `POST /api/schedules`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

**Request Body**:
```json
{
  "name": "string",
  "days": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
  "openTime": "HH:mm",
  "closeTime": "HH:mm"
}
```

---

## Queues

### List Queues

**Endpoint**: `GET /api/queues`

**Required**: Authentication

### Create Queue

**Endpoint**: `POST /api/queues`

**Required**: ADMIN role

**Request Body**:
```json
{
  "name": "string",
  "color": "#3b82f6"
}
```

### Delete Queue

**Endpoint**: `DELETE /api/queues/:id`

**Required**: ADMIN role

---

## Tags

### List Tags

**Endpoint**: `GET /api/tags`

**Required**: Authentication, ADMIN, MANAGER, or SUPER_ADMIN

### Create Tag

**Endpoint**: `POST /api/tags`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

**Request Body**:
```json
{
  "name": "string",
  "color": "#3B82F6"
}
```

### Update Tag

**Endpoint**: `PUT /api/tags/:id`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

### Delete Tag

**Endpoint**: `DELETE /api/tags/:id`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

---

## Webhooks

### List Webhooks

**Endpoint**: `GET /api/webhooks`

**Required**: Authentication, ADMIN or SUPER_ADMIN

### Create Webhook

**Endpoint**: `POST /api/webhooks`

**Required**: ADMIN or SUPER_ADMIN

**Request Body**:
```json
{
  "name": "string",
  "url": "https://...",
  "events": ["chat.created", "chat.closed"],
  "secret": "string"
}
```

### Update Webhook

**Endpoint**: `PUT /api/webhooks/:id`

**Required**: ADMIN or SUPER_ADMIN

### Delete Webhook

**Endpoint**: `DELETE /api/webhooks/:id`

**Required**: ADMIN or SUPER_ADMIN

---

## Chats

### List Chats

**Endpoint**: `GET /api/chats`

**Required**: Authentication, valid tenant

### Get Chat

**Endpoint**: `GET /api/chats/:id`

**Required**: Authentication, valid tenant

---

## Canned Responses

### List Responses

**Endpoint**: `GET /api/cannedResponses`

**Required**: Authentication, ADMIN, MANAGER, or SUPER_ADMIN

### Create Response

**Endpoint**: `POST /api/cannedResponses`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

**Request Body**:
```json
{
  "name": "string",
  "message": "string",
  "shortcut": "string"
}
```

### Update Response

**Endpoint**: `PUT /api/cannedResponses/:id`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

### Delete Response

**Endpoint**: `DELETE /api/cannedResponses/:id`

**Required**: ADMIN, MANAGER, or SUPER_ADMIN

---

## Logs

### Get Logs

**Endpoint**: `GET /api/logs`

**Required**: Authentication

**Response** (200):
```json
{
  "logs": [...],
  "total": 100,
  "page": 1,
  "totalPages": 1
}
```

---

## Super Admin

### Dashboard

**Endpoint**: `GET /api/super-admin/dashboard`

**Required**: SUPER_ADMIN role

**Response** (200):
```json
{
  "tenants": {
    "total": 10,
    "ativos": 8,
    "trial": 2,
    "suspensos": 0
  },
  "usuarios": {
    "total": 100,
    "porTenant": [...]
  },
  "flows": {
    "total": 50,
    "porTenant": [...]
  },
  "chats": {
    "total": 500,
    "porTenant": [...]
  },
  "billing": [
    {
      "tenantId": "string",
      "name": "string",
      "plan": "free | basic | pro",
      "status": "active"
    }
  ]
}
```

---

## Database Schema

### Collections

| Collection | Description |
|------------|-------------|
| users | User accounts with roles and tenant association |
| tenants | Multi-tenant organization records |
| flows | Chatbot flow definitions (nodes/edges) |
| variables | Global and flow variables |
| messageTemplates | Reusable message templates |
| schedules | Business hour schedules |
| queues | Chat routing queues |
| tags | Chat categorization tags |
| webhooks | External event subscriptions |
| activeChats | Current chat sessions |
| cannedResponses | Quick reply templates |
| systemLogs | Audit and event logs |

### Document Structure

**User**:
```json
{
  "id": "string",
  "name": "string",
  "username": "string",
  "password": "bcrypt_hash",
  "role": "SUPER_ADMIN | ADMIN | MANAGER | AGENT",
  "queues": ["queue_id_1"],
  "tenantId": "tenant_id",
  "permissions": [],
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "createdBy": "user_id"
}
```

**Flow**:
```json
{
  "id": "string",
  "name": "string",
  "description": "string",
  "status": "draft | published",
  "version": 1,
  "tenantId": "string",
  "draft": {
    "nodes": [...],
    "edges": [...]
  },
  "published": {...},
  "createdAt": "ISO8601",
  "updatedAt": "ISO8601",
  "createdBy": "user_id"
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| PORT | No | 3001 | Server port |
| NODE_ENV | No | development | Environment mode |
| MONGODB_URI | Yes | - | MongoDB connection string |
| MONGODB_DB_NAME | No | Onion Flows | Database name |
| JWT_SECRET | Yes (production) | - | JWT signing key |
| ADMIN_INITIAL_PASSWORD | No | - | Initial admin password used by `scripts/seed-admin.js` |
| JWT_EXPIRES_IN | No | 8h | Token expiration |

---

## Error Codes

| Code | Meaning |
|------|---------|
| 400 | Bad Request - Validation failed |
| 401 | Unauthorized - Invalid or missing token |
| 403 | Forbidden - Insufficient permissions |
| 404 | Not Found - Resource does not exist |
| 500 | Internal Server Error |

**Error Response**:
```json
{
  "error": "Human-readable error message"
}
```

---

## Socket.IO Events

### Server to Client

| Event | Description |
|-------|-------------|
| new_log | New system log entry |

### Client to Server

Configure Socket.IO client to connect to the same server URL.

---

## Rate Limiting

- API: 100 requests per minute
- Login: 50 attempts per 15 minutes

---

## Running the Server

```bash
cd server
npm install
npm start
```

Server runs on `http://localhost:3001`

---

## Health Check

**Endpoint**: `GET /health`

**Response**:
```json
{
  "status": "ok"
}
```



