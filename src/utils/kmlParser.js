import fs from 'fs';
import path from 'path';
import { XMLParser } from 'fast-xml-parser';

let cachedData = null;
let lastReadTime = 0;

/**
 * Parses coordinate string from KML (longitude,latitude,altitude ...)
 * Returns array of [lat, lng] for Leaflet map display.
 */
function parseCoordinateString(coordStr) {
  if (!coordStr) return [];
  const points = coordStr.trim().split(/\s+/);
  const result = [];
  for (const p of points) {
    const parts = p.split(',');
    if (parts.length >= 2) {
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!isNaN(lat) && !isNaN(lng)) {
        result.push([lat, lng]);
      }
    }
  }
  return result;
}

/**
 * Point-in-polygon test (ray casting algorithm)
 * lat, lng -> check if inside polygon coords [[lat, lng], ...]
 */
function isPointInPolygon(point, polygon) {
  const [x, y] = point; // lat, lng
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function parseKMLFile(filePath = 'mapping3.kml') {
  try {
    let resolvedPath = path.resolve(filePath);
    
    // Check if resolved path exists in process.cwd() or relative path
    if (!fs.existsSync(resolvedPath)) {
      const localMapping3 = path.join(process.cwd(), 'mapping3.kml');
      const localMapping = path.join(process.cwd(), 'mapping.kml');
      
      if (fs.existsSync(localMapping3)) {
        resolvedPath = localMapping3;
      } else if (fs.existsSync(localMapping)) {
        resolvedPath = localMapping;
      } else if (fs.existsSync('D:/mapping3.kml')) {
        resolvedPath = 'D:/mapping3.kml';
      } else if (fs.existsSync('D:/mapping.kml')) {
        resolvedPath = 'D:/mapping.kml';
      } else {
        // Look inside src folder if running from root
        const srcMapping3 = path.join(process.cwd(), 'src', 'mapping3.kml');
        if (fs.existsSync(srcMapping3)) {
          resolvedPath = srcMapping3;
        }
      }
    }

    const stats = fs.statSync(resolvedPath);
    if (cachedData && stats.mtimeMs <= lastReadTime) {
      return cachedData;
    }

    const xmlContent = fs.readFileSync(resolvedPath, 'utf-8');
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });

    const parsedXml = parser.parse(xmlContent);
    const kmlDoc = parsedXml?.kml?.Document;

    if (!kmlDoc) {
      throw new Error('Invalid KML structure: Document node missing');
    }

    const depot = { name: 'DEPOT', lat: 19.892379, lng: 74.484606 };
    const zones = [];
    const routes = [];
    const bins = [];
    const trucks = [];

    // Helper to process a single Placemark node
    function processPlacemark(pm) {
      const name = pm.name || 'Unnamed';
      const id = pm['@_id'] || name;
      const description = pm.description || '';

      // 1. Check if Polygon (Zone)
      if (pm.Polygon) {
        const coordStr = pm.Polygon?.outerBoundaryIs?.LinearRing?.coordinates;
        const coords = parseCoordinateString(coordStr);
        zones.push({
          id,
          name,
          description,
          coordinates: coords,
        });
        return;
      }

      // 2. Check if LineString (Route)
      if (pm.LineString) {
        const coordStr = pm.LineString?.coordinates;
        const coords = parseCoordinateString(coordStr);
        routes.push({
          id,
          name,
          description,
          coordinates: coords,
        });
        return;
      }

      // 3. Check if Point (Bin, Depot, Truck)
      if (pm.Point) {
        const coordStr = pm.Point?.coordinates;
        const coords = parseCoordinateString(coordStr);
        if (coords.length > 0) {
          const [lat, lng] = coords[0];

          if (name.toUpperCase().includes('DEPOT')) {
            depot.lat = lat;
            depot.lng = lng;
            depot.name = name;
          } else if (name.toUpperCase().startsWith('TRUCK')) {
            trucks.push({
              id,
              name,
              description,
              lat,
              lng,
            });
          } else {
            // It's a bin / stop point (BIN-001, SOC-001, HH-001, etc.)
            bins.push({
              id,
              name,
              lat,
              lng,
              zone: null, // to be computed
            });
          }
        }
      }
    }

    // Recursively collect all Placemarks in Document & Folders
    function collectPlacemarks(node) {
      if (!node) return;
      if (Array.isArray(node.Placemark)) {
        node.Placemark.forEach(processPlacemark);
      } else if (node.Placemark) {
        processPlacemark(node.Placemark);
      }

      if (Array.isArray(node.Folder)) {
        node.Folder.forEach(collectPlacemarks);
      } else if (node.Folder) {
        collectPlacemarks(node.Folder);
      }
    }

    collectPlacemarks(kmlDoc);

    // Assign bins to Zone A or Zone B based on Polygon test or latitude cutoff
    const zoneAPoly = zones.find(z => z.name.toUpperCase().includes('ZONE A'));
    const zoneBPoly = zones.find(z => z.name.toUpperCase().includes('ZONE B'));

    bins.forEach(bin => {
      if (zoneAPoly && isPointInPolygon([bin.lat, bin.lng], zoneAPoly.coordinates)) {
        bin.zone = 'ZONE A';
      } else if (zoneBPoly && isPointInPolygon([bin.lat, bin.lng], zoneBPoly.coordinates)) {
        bin.zone = 'ZONE B';
      } else {
        // Fallback lat threshold for Nashik region in KML: lat > 19.900 => Zone A, lat <= 19.900 => Zone B
        bin.zone = bin.lat > 19.900 ? 'ZONE A' : 'ZONE B';
      }
    });

    // Map routes to zones
    routes.forEach(route => {
      if (route.name.includes('TRUCK-001')) {
        route.zone = 'ZONE A';
      } else if (route.name.includes('TRUCK-002')) {
        route.zone = 'ZONE B';
      } else {
        route.zone = 'ALL';
      }
    });

    cachedData = {
      depot,
      zones,
      routes,
      bins,
      trucks,
    };
    lastReadTime = stats.mtimeMs;

    return cachedData;
  } catch (err) {
    console.error('Error parsing KML file:', err);
    throw err;
  }
}
