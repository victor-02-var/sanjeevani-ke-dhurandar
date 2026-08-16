from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from ortools.constraint_solver import routing_enums_pb2
from ortools.constraint_solver import pywrapcp

app = FastAPI(title="Garbage Route Optimizer with Territory & Capacity Constraints")

class VehicleInput(BaseModel):
    vehicleId: str
    capacity: int
    currentLoad: int = 0
    minLat: Optional[float] = None
    maxLat: Optional[float] = None
    minLng: Optional[float] = None
    maxLng: Optional[float] = None

class LocationInput(BaseModel):
    id: str
    type: str  # 'DEPOT' or 'BIN'
    demand: int = 0
    latitude: float
    longitude: float

class OptimizationRequest(BaseModel):
    vehicles: List[VehicleInput]
    locations: List[LocationInput]
    distanceMatrix: List[List[float]]  # Meters
    durationMatrix: List[List[float]]  # Seconds

@app.get("/health")
def health_check():
    return {"status": "OK", "service": "Graspit OR-Tools VRP Solver"}

# Registering decorators for /solve-vrp, /optimize, and trailing slashes
@app.post("/solve-vrp")
@app.post("/solve-vrp/")
@app.post("/optimize")
@app.post("/optimize/")
def solve_vrp(payload: OptimizationRequest):
    try:
        num_vehicles = len(payload.vehicles)
        num_locations = len(payload.locations)
        
        if num_vehicles == 0 or num_locations <= 1:
            return {"routes": [], "totalDistanceMeters": 0, "totalDurationSeconds": 0}

        # Create Routing Model
        manager = pywrapcp.RoutingIndexManager(num_locations, num_vehicles, 0)
        routing = pywrapcp.RoutingModel(manager)

        # 1. Distance Callback & Cost Matrix with Territory Penalties
        def distance_callback(from_index, to_index):
            from_node = manager.IndexToNode(from_index)
            to_node = manager.IndexToNode(to_index)
            
            base_distance = payload.distanceMatrix[from_node][to_node]
            
            # If target node is a BIN (index != 0), apply territory penalty check
            if to_node != 0:
                bin_loc = payload.locations[to_node]
                
                # Retrieve vehicle index safely
                vehicle_idx = 0
                if hasattr(routing, 'UnravelVehicleCode'):
                    vehicle_idx = routing.UnravelVehicleCode(from_index)
                
                v = payload.vehicles[vehicle_idx % num_vehicles]
                
                if v.minLat is not None and v.maxLat is not None and v.minLng is not None and v.maxLng is not None:
                    in_territory = (v.minLat <= bin_loc.latitude <= v.maxLat) and \
                                   (v.minLng <= bin_loc.longitude <= v.maxLng)
                    if not in_territory:
                        return int(base_distance + 1_000_000)  # Soft penalty for out-of-territory bins
            
            return int(base_distance)

        transit_callback_index = routing.RegisterTransitCallback(distance_callback)
        routing.SetArcCostEvaluatorOfAllVehicles(transit_callback_index)

        # 2. Demand & Capacity Constraints
        demands = [loc.demand for loc in payload.locations]
        capacities = [max(0, v.capacity - v.currentLoad) for v in payload.vehicles]

        def demand_callback(from_index):
            from_node = manager.IndexToNode(from_index)
            return demands[from_node]

        demand_callback_index = routing.RegisterUnaryTransitCallback(demand_callback)
        routing.AddDimensionWithVehicleCapacity(
            demand_callback_index,
            0,          # null capacity slack
            capacities, # vehicle maximum remaining capacities
            True,       # start at zero
            "Capacity"
        )

        # Search Parameters
        search_parameters = pywrapcp.DefaultRoutingSearchParameters()
        search_parameters.first_solution_strategy = (
            routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
        )
        search_parameters.local_search_metaheuristic = (
            routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        )
        search_parameters.time_limit.seconds = 3

        # Solve
        solution = routing.SolveWithParameters(search_parameters)

        if not solution:
            raise HTTPException(status_code=400, detail="Could not find a feasible route solution.")

        output_routes = []
        total_distance = 0

        for vehicle_id in range(num_vehicles):
            index = routing.Start(vehicle_id)
            route_bins = []
            route_dist = 0
            
            while not routing.IsEnd(index):
                node_index = manager.IndexToNode(index)
                if node_index != 0:
                    route_bins.append(payload.locations[node_index].id)
                
                previous_index = index
                index = solution.Value(routing.NextVar(index))
                route_dist += routing.GetArcCostForVehicle(previous_index, index, vehicle_id) % 1_000_000

            output_routes.append({
                "vehicleId": payload.vehicles[vehicle_id].vehicleId,
                "bins": route_bins,
                "routeDistanceMeters": route_dist
            })
            total_distance += route_dist

        return {
            "routes": output_routes,
            "totalDistanceMeters": total_distance,
            "totalDurationSeconds": int(total_distance / 8.33)  # Approx 30km/h average urban speed
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))