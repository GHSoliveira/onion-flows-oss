import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const createDevelopmentEnv = () => {
  const devSecret = crypto.randomBytes(32).toString('hex');

  const envContent = `# SEGURANCA
JWT_SECRET=${devSecret}
JWT_EXPIRES_IN=8h

# CONFIGURACAO
NODE_ENV=development
PORT=3001
CLIENT_URL=http://localhost:5173

# BANCO DE DADOS (OPCIONAL)
# Descomente para usar MongoDB
# MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>/<db>?retryWrites=true&w=majority
MONGODB_DB_NAME=onionflow

# LOGS
LOG_LEVEL=info
LOG_FILE_PATH=./logs

# RATE LIMITING
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100
LOGIN_RATE_LIMIT_MAX=5

# WEBSOCKETS
SOCKET_CORS_ORIGIN=http://localhost:5173

# ADAPTER
USE_MONGODB=false
`;

  const envPath = path.join(__dirname, '..', '.env');
  fs.writeFileSync(envPath, envContent, 'utf8');
  console.log('Arquivo .env de desenvolvimento criado com JWT_SECRET aleatorio.');
};

createDevelopmentEnv();
