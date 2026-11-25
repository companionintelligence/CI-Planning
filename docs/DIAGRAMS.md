# Companion Planning — Current System Flows

Updated 2026-11-24 from the current client, server routes/services, Store facade, job registry, and metrics code. Solid edges are implemented request/data paths. Dashed edges are optional integrations or the unfinished PostgreSQL port. These five diagrams describe the live system; historical and feature-specific diagrams elsewhere in the repository remain scoped to their original documents.

## System flow

```mermaid
flowchart LR
  subgraph Clients["Client surfaces"]
    Browser["Browser SPA<br/>SolidJS + Vite"]
    Mobile["Capacitor iOS / Android<br/>bundled client"]
    Desktop["Tauri desktop<br/>bundled client"]
  end
  subgraph Server["Companion Planning server — Node.js / Koa"]
    Static["Static client delivery"]
    Auth["Authentication<br/>session + owner context"]
    REST["REST routes"]
    GraphQL["Apollo GraphQL"]
    Services["Shared owner-scoped services"]
    Engines["Domain engines<br/>schedule · recurrence · reflow · metrics"]
    Jobs["Croner jobs"]
    Agent["Task and scheduled agents"]
    Connectors["Connector boundary"]
    SSE["SSE event hub"]
    Store["Async Store facade"]
  end
  SQLite[("SQLite / WAL<br/>supported default")]
  Postgres[("PostgreSQL port<br/>unfinished")]
  LLM["Configured LLM<br/>Ollama or compatible provider"]
  Google["Google Calendar / Gmail"]
  Memory["Memory / Companion Portal"]
  Delivery["Web Push / email"]

  Browser --> Static
  Browser <--> Auth
  Mobile <--> Auth
  Desktop <--> Auth
  Auth --> REST
  Auth --> GraphQL
  REST --> Services
  GraphQL --> Services
  Services <--> Engines
  Services --> Agent
  Jobs --> Services
  Jobs --> Agent
  Agent <--> Connectors
  Connectors -.-> LLM
  Connectors -.-> Google
  Connectors -.-> Memory
  Jobs -.-> Delivery
  Services --> Store
  Engines --> Store
  Store --> SQLite
  Store -. "not a supported deployment backend" .-> Postgres
  REST -. "selected write events" .-> SSE
  GraphQL -. "selected write events" .-> SSE
  Jobs -. "job events" .-> SSE
  SSE -. "refresh selected client stores" .-> Browser
  SSE -. "refresh selected client stores" .-> Mobile
  SSE -. "refresh selected client stores" .-> Desktop

  classDef built fill:#eaf3ff,stroke:#2b6cb0,color:#13315c;
  classDef optional fill:#fff7e6,stroke:#c08a1e,color:#6d4d00,stroke-dasharray:5 4;
  class Browser,Mobile,Desktop,Static,Auth,REST,GraphQL,Services,Engines,Jobs,Agent,Connectors,SSE,Store,SQLite built;
  class Postgres,LLM,Google,Memory,Delivery optional;
```

## User flow

```mermaid
flowchart TD
  SignIn["Sign in<br/>local credentials or Companion Portal"] --> Today["Today cockpit"]
  Today --> Focus["Focus<br/>choose day · priorities · habits · note"]
  Today --> Tasks["Tasks<br/>capture · search · edit · complete · notes"]
  Today --> Planner["Planner"]
  Tasks --> SwipeStage["Swipe right<br/>stage task"]
  SwipeStage --> FlightPlan["Flight Plan"]
  Tasks --> SwipeActions["Swipe left<br/>reveal Archive / Delete"]
  SwipeActions --> Archive["Archive / restore"]
  SwipeActions --> ThrownAway["Delete to Thrown away<br/>restorable state"]
  FlightPlan --> Schedule["Review and schedule selected tasks"]
  Planner --> Schedule
  Schedule --> Adjust["Inspect blocks<br/>move · resize · lock · undo"]
  Adjust --> Work["Work and complete"]
  Work --> Reflect["Close ritual<br/>rating and tracked time"]
  Reflect --> Metrics["Balance → Metrics<br/>daily recap and learning"]
  Tasks --> Objectives["Objectives<br/>group work and review progress"]
  Today --> Assistant["Task assistant<br/>ask about tasks, screen, or metrics"]
  Assistant --> Answer["Read-only answer"]
  Assistant --> Proposal["Review proposed changes"]
  Proposal -->|Edit or clarify| Proposal
  Proposal -->|Discard| Today
  Proposal -->|Confirm| Apply["Apply through existing APIs"]
  Apply --> Today
```

## Data flow

```mermaid
flowchart LR
  UI["Views and components"] <--> State["Solid resources and stores"]
  State <--> APIClient["Typed client API"]
  APIClient <--> Auth["Koa auth + owner context"]
  Auth --> REST["REST routes"]
  Auth --> GraphQL["GraphQL resolvers"]
  REST --> Services["Shared services<br/>validation · owner-scoped rules"]
  GraphQL --> Services
  Services <--> Engines["Scheduling · recurrence · reflow · metrics"]
  Services --> Store["Async Store facade"]
  Engines --> Store
  Store <--> DB[("SQLite / WAL")]
  DB --> Result["Owner-scoped DTO / result"]
  Result --> APIClient
  REST -. "selected broadcasts" .-> Events["SSE events<br/>emitted at transport/job boundary"]
  GraphQL -. "selected broadcasts" .-> Events
  Jobs["Background jobs"] -. "job/resource events" .-> Events
  Events -. "event handler refetches selected resources" .-> State
  REST --> Agent["Task-agent planning route"]
  Agent -->|"proposal only; no write"| Proposal["Assistant response"]
  Proposal --> APIClient
  UI -->|"user confirms proposal"| APIClient
```

## Agent flow

```mermaid
sequenceDiagram
  actor User
  participant UI as Task assistant UI
  participant Route as POST /api/task-agent/plan
  participant Scope as Owner-scoped context/services
  participant Store as Store / SQLite
  participant Model as Configured LLM
  participant API as Existing task / block APIs
  User->>UI: Ask, dictate, or answer a clarification
  UI->>Route: Message + bounded history + screen summary
  Route->>Scope: Find candidate tasks, objectives, and relevant tagged blocks
  Scope->>Store: Owner-scoped reads only
  Store-->>Scope: Current records and state
  Route->>Model: Request + bounded context
  alt Provider unavailable
    Model-->>Route: No usable response
    Route-->>UI: 503; no write
  else Provider returns a proposal
    Model-->>Route: JSON reply and proposed actions
    Route->>Route: Validate action kinds, known IDs, fields, and scope
    Route-->>UI: Reply + editable proposal; no task write
    UI-->>User: Review, edit, clarify, confirm, or discard
    User->>UI: Confirm proposal
    UI->>API: Apply accepted action(s) through existing endpoints
    API->>Scope: Validate and perform owner-scoped writes
    Scope->>Store: Persist task / objective / block changes
    Store-->>API: Updated records
    API-->>UI: Success or per-item failure
    API-->>UI: Selected SSE events trigger store refreshes
    UI-->>User: Show outcome
  end
```

## Metric flow

```mermaid
flowchart LR
  TaskData["Task lifecycle<br/>completion · cancellation · actual minutes · rating"] --> TaskMetrics["taskMetrics(owner, days)"]
  HabitData["Rated habit occurrences"] --> TaskMetrics
  TaskMetrics --> TaskAPI["GET /api/metrics/tasks"]
  TaskMetrics --> AgentRecap["Task assistant read-only recap"]
  TrialityData["Suggestion impressions and outcomes"] --> TrialityMetrics["trialityMetrics(owner, now, days)"]
  TrialityMetrics --> TrialityAPI["GET /api/metrics/triality"]
  Evidence["Classification · plan-loop · placement · dismissal evidence"] --> LearningAPI["Learning / calibration APIs"]
  LearningAPI --> Settings["Settings → learning metrics"]
  TaskAPI --> Balance["Balance → Metrics"]
  TrialityAPI --> Balance
  DailyInputs["Tasks, blocks, habits, and daily state"] --> Stars["daily_recap snapshot or computeStars() fallback"]
  Stars --> StarsAPI["GET /api/stars"]
  StarsAPI --> Focus["Focus stars"]
  StarsAPI --> Calendar["Calendar recap / heatmap"]
  StarsAPI --> History["Balance daily completion history"]
  AgentRecap --> Assistant["Task assistant"]
```
