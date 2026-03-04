# Global Airline Network Visualization

This project is an interactive data visualization system for exploring the global airline network using the OpenFlights Airports and Routes dataset.
The system provides multiple coordinated views that help users analyze airport connectivity, route distance patterns, and global flight routing behavior.

The interface allows users to explore worldwide aviation data through interactive maps and charts.

## System Features

The visualization system includes five main views:

### Routing View
Allows users to explore flight connections between airports and construct route paths interactively.

### Elevation View
Shows how airport elevation relates to geographic location and route activity.

### Hubs View
Identifies major airport hubs by displaying the number of departing flights from each airport.

### Distance View
Visualizes global flight routes grouped by distance categories:
- Short-haul
- Mid-haul
- Long-haul

Users can interact with the distance histogram and category bar to explore how route distances are distributed geographically.

### Curvature View
Displays flight routes on a rotatable 3D globe and analyzes great-circle curvature patterns of long-distance routes.

# Interactions

The visualization system supports several interactive features:

### Hover: 
Display detailed information about airports and routes.

### Linked highlighting: 
Interactions in charts highlight related elements on the map.

### Brushing: 
Select specific ranges in charts (e.g., distance histogram).

### Filtering: 
Focus on selected route categories.

### Drag rotation: 
Rotate the globe in the Curvature view to inspect routes from different angles.

## How to Run the Project

Because the project uses D3.js and loads local data files, it must be served through a local web server.

### 1. Clone the repository

```bash
git clone https://github.com/hsuanlien/Group6_DV.git
cd Group6_DV
