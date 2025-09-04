# Dashboard Application

## Multi-Core Clustering

This application utilizes Node.js clustering to distribute the workload across all available CPU cores on the system. This improves performance and ensures high availability.

### Implementation Details

1. **Cluster Management**: The application uses the Node.js `cluster` module to create worker processes equal to the number of CPU cores available on the system.

2. **Primary Process**: The primary process manages the worker processes and handles tasks that should only run once, such as the login job.

3. **Worker Processes**: Each worker process runs an instance of the Express server, handling HTTP requests independently.

4. **Automatic Recovery**: If a worker process crashes, the primary process automatically spawns a new worker to replace it.

## Access Token Management

This application includes a scheduled job that runs every morning at 6:00 AM to fetch an access token from a login API. The token is stored in a global variable that can be accessed from anywhere in the project.

### Implementation Details

1. **Global Store**: A global store is implemented in `src/config/store.ts` to hold the access token and provide getter/setter methods.

2. **Login Job**: A scheduled job in `src/jobs/loginJob.ts` fetches the access token from the API and stores it in the global store.

3. **Job Scheduling**: The job runs immediately when the application starts and is then scheduled to run every morning at 6:00 AM using node-cron.

### How to Use

1. Set up the required environment variables in your `.env` file:
   ```
   API_USERNAME="your_username"
   API_PASSWORD="your_password"
   LOGIN_API_URL="https://your-api-endpoint.com/login"
   ```

2. Access the token from anywhere in your application:
   ```typescript
   import { getAccessToken } from './config/store.js';
   
   // Use the access token
   const token = getAccessToken();
   ```

## Development

### Prerequisites

- Node.js
- npm

### Installation

1. Clone the repository
2. Install dependencies: `npm install`
3. Copy `.env.example` to `.env` and fill in the required values
4. Start the development server: `npm run dev`