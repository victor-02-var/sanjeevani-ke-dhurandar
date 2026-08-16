from ortools.constraint_solver import pywrapcp, routing_enums_pb2


def optimize(vehicles, locations, distance_matrix, duration_matrix):
    if not vehicles:
        raise ValueError('At least one vehicle is required')
    if len(locations) < 2:
        raise ValueError('Depot and at least one bin are required')
    if len(distance_matrix) != len(locations) or any(len(row) != len(locations) for row in distance_matrix):
        raise ValueError('Distance matrix dimensions do not match locations')

    manager = pywrapcp.RoutingIndexManager(len(locations), len(vehicles), 0)
    routing = pywrapcp.RoutingModel(manager)

    def distance_callback(from_index, to_index):
        from_node = manager.IndexToNode(from_index)
        to_node = manager.IndexToNode(to_index)
        value = distance_matrix[from_node][to_node]
        if value is None:
            return 10**9
        return int(round(value))

    distance_callback_index = routing.RegisterTransitCallback(distance_callback)
    routing.SetArcCostEvaluatorOfAllVehicles(distance_callback_index)
    routing.AddDimension(distance_callback_index, 0, 10**9, True, 'Distance')

    search_parameters = pywrapcp.DefaultRoutingSearchParameters()
    search_parameters.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    search_parameters.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    search_parameters.time_limit.seconds = 10
    solution = routing.SolveWithParameters(search_parameters)
    if solution is None:
        raise ValueError('No feasible routing solution found')

    routes = []
    total_distance = 0
    total_duration = 0
    for vehicle_index, vehicle in enumerate(vehicles):
        index = routing.Start(vehicle_index)
        bin_ids = []
        route_distance = 0
        route_duration = 0
        while not routing.IsEnd(index):
            current_node = manager.IndexToNode(index)
            next_index = solution.Value(routing.NextVar(index))
            next_node = manager.IndexToNode(next_index)
            if locations[current_node]['type'] == 'BIN':
                bin_ids.append(locations[current_node]['id'])
            route_distance += int(round(distance_matrix[current_node][next_node] or 0))
            route_duration += int(round(duration_matrix[current_node][next_node] or 0))
            index = next_index
        total_distance += route_distance
        total_duration += route_duration
        routes.append({
            'vehicleId': vehicle['vehicleId'],
            'bins': bin_ids,
            'distanceMeters': route_distance,
            'durationSeconds': route_duration
        })

    return {
        'routes': routes,
        'totalDistanceMeters': total_distance,
        'totalDurationSeconds': total_duration
    }

