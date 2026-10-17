import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { inventoryRouter } from './routes/inventory.js';

export const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', inventoryRouter);
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof ZodError) return res.status(400).json({ error: 'Please check the entered details.', details: error.flatten() });
  if (typeof error === 'object' && error && 'code' in error && error.code === 'P2002') return res.status(409).json({ error: 'A record with that code or name already exists.' });
  console.error(error);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
});
