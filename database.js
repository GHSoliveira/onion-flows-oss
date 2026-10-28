import { MongoClient } from 'mongodb';


const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || 'fiberbot';

if (!MONGODB_URI) {
  console.warn('⚠️ MONGODB_URI não encontrado. Usando fallback JSON file.');
  throw new Error('MONGODB_URI é obrigatório para produção');
}

let client;
let db;


export const connectDB = async () => {
  if (client) return db;

  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ Conectado ao MongoDB Atlas');
    return db;
  } catch (error) {
    console.error('❌ Erro ao conectar MongoDB:', error);
    process.exit(1);
  }
};


export class MongoRepository {
  constructor(collectionName) {
    this.collection = () => db.collection(collectionName);
  }

  async findAll() {
    try {
      return await this.collection().find({}).toArray();
    } catch (error) {
      console.error(`Erro em findAll ${this.collection().collectionName}:`, error);
      return [];
    }
  }

  async findById(id) {
    try {
      return await this.collection().findOne({ id });
    } catch (error) {
      console.error(`Erro em findById ${this.collection().collectionName}:`, error);
      return null;
    }
  }

  async create(data) {
    try {
      const result = await this.collection().insertOne(data);
      return { ...data, _id: result.insertedId };
    } catch (error) {
      console.error(`Erro em create ${this.collection().collectionName}:`, error);
      throw error;
    }
  }

  async update(id, data) {
    try {
      const result = await this.collection().updateOne(
        { id },
        { $set: data }
      );
      return result.modifiedCount > 0;
    } catch (error) {
      console.error(`Erro em update ${this.collection().collectionName}:`, error);
      throw error;
    }
  }

  async delete(id) {
    try {
      const result = await this.collection().deleteOne({ id });
      return result.deletedCount > 0;
    } catch (error) {
      console.error(`Erro em delete ${this.collection().collectionName}:`, error);
      throw error;
    }
  }

  async findBy(query) {
    try {
      return await this.collection().find(query).toArray();
    } catch (error) {
      console.error(`Erro em findBy ${this.collection().collectionName}:`, error);
      return [];
    }
  }
}


export const closeDB = async () => {
  if (client) {
    await client.close();
    console.log('📊 Conexão MongoDB fechada');
  }
};