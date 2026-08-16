import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';

import citizenAuthRoutes from './routes/authCitizenRoutes.js';
import adminAuthRoutes from './routes/authAdminRoutes.js';
import complaintRoutes from './routes/complaintRoutes.js';
import trackingRoutes from './routes/trackingRoutes.js';
import binRoutes from './routes/binRoutes.js';
import collectionRoutes from './routes/collectionRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import routeRoutes from './routes/routeRoutes.js';
// import dashboardRoutes from './routes/dashboardRoutes.js';

import { errorHandler } from './middleware/errorHandler.js';

dotenv.config();

const app = express();

// Allowed Origins for Development & Production
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman, mobile apps, curl) or allowed origins
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS Error: Origin ${origin} is not allowed by CORS policy.`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  credentials: true,
  optionsSuccessStatus: 200
};

// Middlewares
app.use(cors(corsOptions)); // Automatically handles preflight (OPTIONS) requests
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

// Auth Routes
app.use('/api/auth/citizen', citizenAuthRoutes);
app.use('/api/auth/admin', adminAuthRoutes);

// Feature Routes
app.use('/api/tracking', trackingRoutes); 
app.use('/api/complaints', complaintRoutes);
app.use('/api/bins', binRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/routes', routeRoutes);
// app.use('/api/dashboard', dashboardRoutes);

// Global Error Handler (MUST BE LAST)
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Waste Management Backend running on port ${PORT}`);
});