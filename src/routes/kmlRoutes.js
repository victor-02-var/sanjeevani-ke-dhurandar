import express from 'express';
import path from 'path';
import { getKMLAdminMap, getKMLDriverMap, toggleBinCollection, assignDriverZone } from '../controllers/kmlController.js';

const router = express.Router();

// Admin: Get all KML zones, routes, bins & collection status
router.get('/zones', getKMLAdminMap);

// Admin: Assign Driver to Zone 1 (Zone A) or Zone 2 (Zone B)
router.post('/assign-zone', assignDriverZone);

// Driver: Get driver-specific zone, route & bins
router.get('/driver-map', getKMLDriverMap);

// Toggle Bin Collection Status (YES/NO)
router.post('/mark-collected', toggleBinCollection);

// Serve raw static mapping3.kml file
router.get('/mapping.kml', (req, res) => {
  const targetFile = path.resolve('D:/mapping3.kml');
  if (path.extname(targetFile) === '.kml' && path.isAbsolute(targetFile)) {
    res.sendFile(targetFile);
  } else {
    res.sendFile(path.resolve('D:/mapping.kml'));
  }
});
router.get('/mapping3.kml', (req, res) => {
  res.sendFile(path.resolve('D:/mapping3.kml'));
});

export default router;
