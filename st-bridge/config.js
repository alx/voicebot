import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

export default {
    PORT: parseInt(process.env.ST_BRIDGE_PORT || '8091', 10),
    ST_BASE_URL: process.env.ST_BASE_URL || 'http://localhost:8000',
    ST_CHARACTER_NAME: process.env.ST_CHARACTER_NAME || '',
    USER_DATA_DIR: path.join(__dirname, '.browser-data'),
    REPLY_TIMEOUT_MS: parseInt(process.env.ST_REPLY_TIMEOUT_MS || '60000', 10),
};
