import { parseKMLFile } from '../utils/kmlParser.js';
import { supabaseAdmin as supabase } from '../config/supabase.js';
import { routeStore } from './routeController.js';

// In-memory collection status store
const collectionStatusStore = new Map();

// In-memory driver-to-zone assignment store (strict 1:1 constraint)
const zoneAssignmentStore = new Map();

/**
 * Haversine formula to calculate distance between 2 GPS coordinates in Kilometers
 */
function getHaversineDistanceKm(lat1, lon1, lat2, lon2) {
  if (lat1 === undefined || lon1 === undefined || lat2 === undefined || lon2 === undefined) return 9999;
  const R = 6371; // Earth radius in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getCollectionStatuses() {
  try {
    const { data, error } = await supabase.from('bin_collection_status').select('*');
    if (!error && data) {
      data.forEach(item => {
        collectionStatusStore.set(item.bin_name, {
          collected: item.is_collected,
          collectedAt: item.collected_at,
          driverName: item.driver_name || item.driver_id,
          driverId: item.driver_id
        });
      });
    }
  } catch (e) {
    // fallback to memory map
  }
  const result = {};
  collectionStatusStore.forEach((val, key) => {
    result[key] = val;
  });
  return result;
}

// GET /api/kml/zones - Full map data for Admin
export const getKMLAdminMap = async (req, res, next) => {
  try {
    const kmlData = parseKMLFile();
    const collectionStatuses = await getCollectionStatuses();

    // Fetch DB vehicles
    let dbVehicles = [];
    try {
      const { data } = await supabase.from('vehicles').select('*');
      dbVehicles = data || [];
    } catch (err) {
      console.warn('Could not fetch DB vehicles for KML matching:', err.message);
    }

    // Synchronize DB vehicle territory_name with zoneAssignmentStore
    dbVehicles.forEach(veh => {
      if (veh.territory_name) {
        const normTerritory = veh.territory_name.toUpperCase().includes('ZONE A') || veh.territory_name.toUpperCase().includes('1') ? 'ZONE A' : (
          veh.territory_name.toUpperCase().includes('ZONE B') || veh.territory_name.toUpperCase().includes('2') ? 'ZONE B' : null
        );
        if (normTerritory && !zoneAssignmentStore.has(normTerritory)) {
          zoneAssignmentStore.set(normTerritory, {
            driverId: veh.id,
            driverName: veh.driver_name || 'Driver',
            licensePlate: veh.license_plate || 'MH-15-XX',
          });
        }
      }
    });

    // Determine driver assignment per zone with 1:1 constraint
    const mappedZones = kmlData.zones.map((zone, idx) => {
      const zoneNameKey = zone.name.toUpperCase().includes('ZONE A') ? 'ZONE A' : 'ZONE B';
      const manualAssigned = zoneAssignmentStore.get(zoneNameKey);

      let matchedVeh = null;
      if (manualAssigned) {
        matchedVeh = dbVehicles.find(v => String(v.id) === String(manualAssigned.driverId) || v.driver_name === manualAssigned.driverName || v.license_plate === manualAssigned.licensePlate);
      }
      
      if (!matchedVeh && !manualAssigned) {
        matchedVeh = dbVehicles.find(v => (v.territory_name || '').toUpperCase().includes(zoneNameKey)) || dbVehicles[idx];
      }

      const assignedDriverName = manualAssigned ? manualAssigned.driverName : (matchedVeh ? matchedVeh.driver_name : (idx === 0 ? 'Ramesh Kumar' : 'Suresh Patil'));
      const assignedLicensePlate = manualAssigned ? manualAssigned.licensePlate : (matchedVeh ? matchedVeh.license_plate : (idx === 0 ? 'MH-15-AB-1001' : 'MH-15-CD-2002'));
      const vehicleId = manualAssigned ? manualAssigned.driverId : (matchedVeh ? matchedVeh.id : `DRIVER-${idx + 1}`);

      const zoneBins = kmlData.bins.filter(b => b.zone === zoneNameKey);
      const truckLat = matchedVeh?.latitude ? parseFloat(matchedVeh.latitude) : (zoneBins[0]?.lat || zone.coordinates[0][0]);
      const truckLng = matchedVeh?.longitude ? parseFloat(matchedVeh.longitude) : (zoneBins[0]?.lng || zone.coordinates[0][1]);

      return {
        ...zone,
        assignedDriverName,
        assignedLicensePlate,
        vehicleId,
        garbageTruck: {
          id: `TRUCK-${zoneNameKey}`,
          driverName: assignedDriverName,
          licensePlate: assignedLicensePlate,
          zone: zoneNameKey,
          lat: truckLat,
          lng: truckLng,
          status: matchedVeh?.status || 'Active On Duty',
          capacityKg: matchedVeh?.capacity_kg || 1000,
        }
      };
    });

    const activeAssignments = {};
    zoneAssignmentStore.forEach((val, key) => {
      activeAssignments[key] = val;
    });

    res.status(200).json({
      success: true,
      depot: kmlData.depot,
      zones: mappedZones,
      routes: kmlData.routes,
      bins: kmlData.bins.map(bin => ({
        ...bin,
        isCollected: !!collectionStatuses[bin.name]?.collected,
        collectedAt: collectionStatuses[bin.name]?.collectedAt || null,
        collectedBy: collectionStatuses[bin.name]?.driverName || null,
      })),
      trucks: mappedZones.map(z => z.garbageTruck),
      collectionStatuses,
      dbVehicles,
      zoneAssignments: activeAssignments,
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/kml/assign-zone - Admin assigns driver to Zone A or Zone B (STRICT 1:1)
export const assignDriverZone = async (req, res, next) => {
  try {
    const { driverId, driverName, licensePlate, zoneName } = req.body;

    if (!zoneName) {
      return res.status(400).json({ error: 'zoneName (ZONE A or ZONE B) is required.' });
    }

    const targetZone = zoneName.toUpperCase().includes('ZONE A') || zoneName.toUpperCase().includes('1') ? 'ZONE A' : 'ZONE B';
    const otherZone = targetZone === 'ZONE A' ? 'ZONE B' : 'ZONE A';

    // If driver is currently assigned to the OTHER zone, unassign them
    const otherZoneAssigned = zoneAssignmentStore.get(otherZone);
    if (
      otherZoneAssigned &&
      (String(otherZoneAssigned.driverId) === String(driverId) || otherZoneAssigned.driverName === driverName || otherZoneAssigned.licensePlate === licensePlate)
    ) {
      zoneAssignmentStore.delete(otherZone);
    }

    // Assign driver to target zone
    zoneAssignmentStore.set(targetZone, {
      driverId: driverId || `DRV-${Date.now()}`,
      driverName: driverName || 'Assigned Driver',
      licensePlate: licensePlate || 'MH-15-XX-9999',
    });

    // Synchronize Database: Clear territory_name from previous vehicle, set targetZone for new vehicle
    try {
      // 1. Clear targetZone from any other vehicle
      await supabase
        .from('vehicles')
        .update({ territory_name: null })
        .eq('territory_name', targetZone);

      // 2. Set targetZone for target vehicle
      if (driverId) {
        await supabase
          .from('vehicles')
          .update({ territory_name: targetZone, driver_name: driverName })
          .eq('id', driverId);
      } else if (licensePlate) {
        await supabase
          .from('vehicles')
          .update({ territory_name: targetZone, driver_name: driverName })
          .eq('license_plate', licensePlate);
      }
    } catch (e) {
      console.warn('DB vehicle territory update fallback:', e.message);
    }

    const currentAssignments = {};
    zoneAssignmentStore.forEach((val, key) => {
      currentAssignments[key] = val;
    });

    res.status(200).json({
      success: true,
      message: `Strict Assignment Synchronized: Driver ${driverName || driverId} is set to ${targetZone} across Route Optimizer & Vehicle Profiles.`,
      assignedZone: targetZone,
      unassignedOtherZone: otherZoneAssigned ? otherZone : null,
      zoneAssignments: currentAssignments,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/kml/driver-map - Filtered map data for logged-in Driver
export const getKMLDriverMap = async (req, res, next) => {
  try {
    const kmlData = parseKMLFile();
    const collectionStatuses = await getCollectionStatuses();

    const driverId = req.user?.id || req.query.driverId;
    const licensePlate = req.query.license_plate;
    const driverName = req.user?.full_name || req.query.driver_name;

    let targetZoneName = 'ZONE A'; // default

    let foundInStore = false;
    for (const [zoneKey, assignObj] of zoneAssignmentStore.entries()) {
      if (
        String(assignObj.driverId) === String(driverId) ||
        (driverName && assignObj.driverName === driverName) ||
        (licensePlate && assignObj.licensePlate === licensePlate)
      ) {
        targetZoneName = zoneKey;
        foundInStore = true;
        break;
      }
    }

    // Check DB vehicle record if not in store
    if (!foundInStore && (driverId || licensePlate || driverName)) {
      try {
        let query = supabase.from('vehicles').select('territory_name');
        if (driverId) query = query.eq('id', driverId);
        else if (licensePlate) query = query.eq('license_plate', licensePlate);
        else if (driverName) query = query.eq('driver_name', driverName);

        const { data: veh } = await query.maybeSingle();
        if (veh?.territory_name) {
          targetZoneName = veh.territory_name.toUpperCase().includes('ZONE B') ? 'ZONE B' : 'ZONE A';
        }
      } catch (e) {
        // ignore
      }
    }

    if (!foundInStore && !targetZoneName) {
      if (req.query.zone === 'ZONE B' || req.query.zone === 'B') {
        targetZoneName = 'ZONE B';
      }
    }

    const targetZone = kmlData.zones.find(z => z.name.toUpperCase().includes(targetZoneName));
    const targetRoute = kmlData.routes.find(r => 
      targetZoneName === 'ZONE A' ? r.name.includes('TRUCK-001') : r.name.includes('TRUCK-002')
    ) || kmlData.routes[0];

    const driverBins = kmlData.bins
      .filter(b => b.zone === targetZoneName)
      .map(bin => ({
        ...bin,
        isCollected: !!collectionStatuses[bin.name]?.collected,
        collectedAt: collectionStatuses[bin.name]?.collectedAt || null,
        collectedBy: collectionStatuses[bin.name]?.driverName || null,
      }));

    const totalBins = driverBins.length;
    const collectedCount = driverBins.filter(b => b.isCollected).length;
    const isAllCollected = totalBins > 0 && collectedCount === totalBins;

    const storedRoute = routeStore.get(String(driverId)) ||
                        routeStore.get(String(targetZoneName)) ||
                        (driverName ? routeStore.get(String(driverName).toLowerCase()) : null);

    const activeRoute = storedRoute?.geometry ? {
      name: `OPTIMIZED-${targetZoneName}`,
      coordinates: storedRoute.geometry.coordinates.map(([lng, lat]) => [lat, lng])
    } : targetRoute;

    res.status(200).json({
      success: true,
      driverZone: targetZone,
      driverZoneName: targetZoneName,
      route: activeRoute,
      optimizedRoute: storedRoute?.geometry || null,
      bins: driverBins,
      depot: kmlData.depot,
      isAllCollected,
      progress: {
        total: totalBins,
        collected: collectedCount,
        percentage: Math.round((collectedCount / (totalBins || 1)) * 100),
      },
    });
  } catch (err) {
    next(err);
  }
};

// POST /api/kml/mark-collected - Toggle Bin Collection Yes/No
export const toggleBinCollection = async (req, res, next) => {
  try {
    const { binName, binId, collected, driverName, driverId, driverLat, driverLng, isAdminOverride } = req.body;
    const targetBinName = binName || binId;

    if (!targetBinName) {
      return res.status(400).json({ error: 'binName or binId is required' });
    }

    const isCollected = collected === true || collected === 'true' || collected === 'YES' || collected === 'yes';
    const now = new Date();

    if (isCollected && !isAdminOverride) {
      const kmlData = parseKMLFile();
      const targetBin = kmlData.bins.find(b => b.name === targetBinName || b.id === targetBinName);

      if (!targetBin) {
        return res.status(404).json({ error: `Bin "${targetBinName}" not found in KML map.` });
      }

      // Check 1-Hour Scan Timer
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
      let recentScans = [];
      try {
        const { data: scanLogs } = await supabase
          .from('vehicle_scan_logs')
          .select('*')
          .gte('scan_timestamp', oneHourAgo);
        recentScans = scanLogs || [];
      } catch (e) {
        console.warn('Scan logs lookup fallback:', e.message);
      }

      let validScanFound = false;
      if (recentScans.length > 0) {
        for (const scan of recentScans) {
          const scanLat = parseFloat(scan.scan_latitude);
          const scanLng = parseFloat(scan.scan_longitude);
          const distToBin = getHaversineDistanceKm(scanLat, scanLng, targetBin.lat, targetBin.lng);

          if (distToBin <= 5.0) { // 5km radius — covers GPS drift and nearby citizen scans
            validScanFound = true;
            break;
          }
        }
      } else {
        validScanFound = true; // No scans yet — allow collection (demo/test mode)
      }

      if (!validScanFound) {
        return res.status(400).json({
          error: `❌ Verification Failed: No citizen QR scan recorded near bin "${targetBinName}" within the last 1 hour. Citizens must scan the bin QR code first!`
        });
      }

      // Check Driver Mobile GPS Proximity
      if (driverLat !== undefined && driverLng !== undefined && driverLat !== null && driverLng !== null) {
        const dLat = parseFloat(driverLat);
        const dLng = parseFloat(driverLng);

        const distToPickupSpot = getHaversineDistanceKm(dLat, dLng, targetBin.lat, targetBin.lng);

        if (distToPickupSpot > 2.0) { // 2km radius — allows for GPS offset on mobile devices
          const distanceMeters = Math.round(distToPickupSpot * 1000);
          return res.status(400).json({
            error: `❌ GPS Mismatch: Your GPS location is ${distanceMeters}m away from bin "${targetBinName}". Please be closer to the bin to mark collection.`
          });
        }
      }
    }

    collectionStatusStore.set(targetBinName, {
      collected: isCollected,
      collectedAt: isCollected ? now.toISOString() : null,
      driverName: driverName || 'Driver',
      driverId: driverId || null,
    });

    try {
      await supabase.from('bin_collection_status').upsert({
        bin_name: targetBinName,
        is_collected: isCollected,
        collected_at: isCollected ? now.toISOString() : null,
        driver_name: driverName || 'Driver',
        driver_id: driverId || null,
      }, { onConflict: 'bin_name' });
    } catch (e) {
      // ignore
    }

    const allStatuses = {};
    collectionStatusStore.forEach((val, key) => {
      allStatuses[key] = val;
    });

    res.status(200).json({
      success: true,
      message: `Bin ${targetBinName} marked as ${isCollected ? 'COLLECTED (YES)' : 'PENDING (NO)'}`,
      binName: targetBinName,
      isCollected,
      collectionStatuses: allStatuses,
    });
  } catch (err) {
    next(err);
  }
};
