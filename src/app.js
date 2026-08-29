import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';

import citizenAuthRoutes from './routes/authCitizenRoutes.js';
import adminAuthRoutes from './routes/authAdminRoutes.js';
import driverAuthRoutes from './routes/authDriverRoutes.js';
import vehicleAuthorityAuthRoutes from './routes/authVehicleAuthorityRoutes.js';
import vehicleAuthRoutes from './routes/authVehicleRoutes.js';
import citizenRoutes from './routes/citizenRoutes.js';
import adminRoutes from './routes/adminRoutes.js';
import driverRoutes from './routes/driverRoutes.js';
import complaintRoutes from './routes/complaintRoutes.js';
import trackingRoutes from './routes/trackingRoutes.js';
import binRoutes from './routes/binRoutes.js';
import collectionRoutes from './routes/collectionRoutes.js';
import vehicleRoutes from './routes/vehicleRoutes.js';
import vehicleAuthorityRoutes from './routes/vehicleAuthorityRoutes.js';
import routeRoutes from './routes/routeRoutes.js';
import carbonPointsRoutes from './routes/carbonPointsRoutes.js';
import qrRoutes from './routes/qrRoutes.js';
import qrScanRoutes from './routes/qrScanRoutes.js';
import kmlRoutes from './routes/kmlRoutes.js';
import deadAnimalRoutes from './routes/deadAnimalRoutes.js';
// import dashboardRoutes from './routes/dashboardRoutes.js';

import { errorHandler } from './middleware/errorHandler.js';

dotenv.config();

const app = express();

// Allowed Origins for Development & Production
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8080',
  'http://localhost:8081',
  'http://localhost:5174',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:8081',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  "https://frontend-admin-red-nine.vercel.app",
  "https://citizen-frontend-lemon.vercel.app",
  "https://driver-jet.vercel.app",
  "https://civic-sync-citizen-dashboard.vercel.app",
  "https://civic-sync-admin-dashboard-25qxuhdz0-aditya-031e.vercel.app",
  "https://route-chief-615toe3li-aditya-031e.vercel.app",

  process.env.FRONTEND_URL
].filter(Boolean);

const corsOptions = {
  origin: (origin, callback) => {
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
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan('dev'));

// 🛠️ SAFETY MIDDLEWARE: Automatically fix double /api/api/ requests from frontend
app.use((req, res, next) => {
  if (req.url.startsWith('/api/api/')) {
    req.url = req.url.replace('/api/api/', '/api/');
  }
  next();
});

// Auth Routes
app.use('/api/auth/citizen', citizenAuthRoutes);
app.use('/api/auth/admin', adminAuthRoutes);
app.use('/api/auth/driver', driverAuthRoutes);
app.use('/api/auth/vehicle-authority', vehicleAuthorityAuthRoutes);
app.use('/api/auth/vehicle', vehicleAuthRoutes);

// Citizen Routes
app.use('/api/citizen', citizenRoutes);

// Admin Routes
app.use('/api/admin', adminRoutes);

// Driver Routes
app.use('/api/driver', driverRoutes);

// Vehicle Authority Routes
app.use('/api/vehicle-authority', vehicleAuthorityRoutes);

// Feature Routes
app.use('/api/tracking', trackingRoutes); 
app.use('/api/complaints', complaintRoutes);
app.use('/api/bins', binRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/collections', collectionRoutes);
app.use('/api/routes', routeRoutes);
app.use('/api/carbon-points', carbonPointsRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/qr-scan', qrScanRoutes);
app.use('/api/kml', kmlRoutes);
app.use('/api/dead-animal-reports', deadAnimalRoutes);
// app.use('/api/dashboard', dashboardRoutes);

// Root health check — shows when visiting the backend URL directly in a browser
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'online',
    message: '🚀 CivicSync Backend API is running!',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      auth: '/api/auth',
      bins: '/api/bins',
      vehicles: '/api/vehicles',
      complaints: '/api/complaints',
      carbonPoints: '/api/carbon-points',
      kml: '/api/kml',
      qr: '/api/qr',
      tracking: '/api/tracking',
      deadAnimalReports: '/api/dead-animal-reports',
    },
    timestamp: new Date().toISOString(),
  });
});

// API health check endpoint
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Global Error Handler (MUST BE LAST)
app.use(errorHandler);

// Start server locally; Vercel handles this automatically via @vercel/node
const PORT = process.env.PORT || 5000;
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`🚀 Waste Management Backend running on port ${PORT}`);
  });
}

// Export for Vercel serverless
export default app;