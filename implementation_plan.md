# Society-Based QR Bin Workflow + Carbon Points System

## Overview

You want to add a **second, parallel workflow** to your existing backend. Currently you have the "Citizen → Spot Garbage → Complaint → Driver Resolves" flow. The new workflow is a **Society/Colony Bin pickup system** with a dynamic QR code, a complaint queue, smart driver assignment, GPS-verified collection proof, and a **Carbon Points** reward system (Carbon Card).

This plan also addresses: how **society-level points** get split and claimed by individual flat owners.

---

## Open Questions (Resolved In Plan)

> [!IMPORTANT]
> **For individual colony homes — how to track if a person threw garbage?**
>
> **Proposed Solution**: Each individual home registered under a colony gets a personal **"throw token"** system. When the garbage vehicle arrives at their colony/street and starts its collection (driver scans the street QR), a **30-minute throw window opens**. During that window, any resident of that colony can tap "I threw my garbage today" in their citizen app — this action is **geo-fenced** (must be within 200m of the bin/vehicle GPS location). This generates a **"throw event"** logged to the DB and gives them points. Since the driver's live GPS is verified, this cannot be faked from home. No IoT sensor needed.

> [!IMPORTANT]
> **Society total points vs. individual flat claiming**
>
> **Proposed Solution**: Society points are split using a **democratic share model**:
> - Total society points earned per collection event = base points × fill_level_factor
> - Each flat that logged a "throw event" during that collection period gets an **equal share** of those points credited to their individual Carbon Card
> - Flats that did NOT throw in that period get 0 share
> - The "Society Carbon Card" shows the cumulative total (public leaderboard-style), while each citizen's personal Carbon Card shows their personal tally
> - Secretary can view flat-wise breakdown in their portal

> [!IMPORTANT]
> **What can Carbon Points be redeemed for?**
> 1. Discount coupons on "Best Out of Waste" marketplace products (products listed on your platform)
> 2. Property tax / water bill rebate vouchers (generated as downloadable PDF, citizen submits to municipality)
> 3. Future: direct integration with municipality payment portal

---

## New Database Tables Required (Supabase SQL)

### 1. `societies`
Represents a housing society with a secretary.
```sql
id, name, address, ward, zone, secretary_citizen_id (FK→citizens), 
qr_code_token (unique, rotating), qr_expires_at, 
total_carbon_points, created_at
```

### 2. `society_members`
Links individual citizens (flat owners/tenants) to a society.
```sql
id, society_id (FK→societies), citizen_id (FK→citizens), 
flat_number, is_secretary (bool), joined_at
```

### 3. `bin_complaints` (new "society bin full" complaint)
Separate from existing `complaints` (roadside litter). This is the secretary-raised "bin is full" request.
```sql
id, society_id (FK→societies), bin_type ('full'|'partial'|'overflow'), 
notes, status ('Pending'|'Queued'|'Assigned'|'Completed'|'Rejected'),
raised_by (FK→citizens), raised_at, scheduled_date,
assigned_vehicle_id (FK→vehicles), driver_scanned_at,
completion_photo_url, driver_latitude, driver_longitude,
is_location_verified (bool), carbon_points_awarded (int)
```

### 4. `throw_events`
Individual throw logging by citizens during a collection window.
```sql
id, society_id (FK→societies), bin_complaint_id (FK→bin_complaints),
citizen_id (FK→citizens), threw_at, citizen_latitude, citizen_longitude,
is_geofence_valid (bool), points_awarded (int)
```

### 5. `carbon_cards`
One card per citizen — their personal carbon wallet.
```sql
id, citizen_id (FK→citizens, unique), total_points, 
redeemed_points, available_points, tier ('Bronze'|'Silver'|'Gold'|'Platinum'),
updated_at
```

### 6. `carbon_redemptions`
Tracks coupon/voucher claims.
```sql
id, carbon_card_id (FK→carbon_cards), citizen_id (FK→citizens),
redemption_type ('marketplace_discount'|'tax_rebate'), 
points_used, discount_percent, voucher_code, 
voucher_pdf_url, status ('Active'|'Used'|'Expired'), created_at
```

### 7. `driver_tasks` (new — replaces ad-hoc complaint assignment)
The daily queue of tasks assigned to each driver.
```sql
id, vehicle_id (FK→vehicles), bin_complaint_id (FK→bin_complaints),
scheduled_date (date), duty_window_start (time), duty_window_end (time),
sequence_order (int), status ('Pending'|'InProgress'|'Completed'|'Rejected'),
assigned_at
```

---

## Proposed Changes

### Component 1 — Database SQL Migration Script

#### [NEW] `scripts/migrate_society_workflow.sql`
Contains all `CREATE TABLE` statements for the 7 new tables above, plus RLS policies.

---

### Component 2 — Society Auth & Registration

#### [NEW] `src/controllers/societyController.js`
- `registerSociety` — Admin creates a society, assigns a secretary from existing citizens
- `getSocietyById` — Get society info + QR token
- `getSocietyMembers` — List all flat owners
- `addSocietyMember` — Admin/Secretary adds a citizen to society with flat number
- `removeSocietyMember`
- `getMySociety` — Citizen fetches their linked society

#### [NEW] `src/routes/societyRoutes.js`
- `POST /api/societies` — Admin only
- `GET /api/societies/:id` — Secretary/Admin
- `POST /api/societies/:id/members` — Admin/Secretary
- `GET /api/societies/my-society` — Citizen

---

### Component 3 — Dynamic QR Code System

> [!NOTE]
> The QR code is "dynamic" in the sense that its token **rotates every 24 hours** (or on each successful pickup). The physical printed QR on the dustbin points to a URL like `https://yourapp.com/qr/scan?token=<rotating_token>`. The backend validates the token. Drivers get a different QR action than secretaries.

#### [MODIFY] `src/controllers/societyController.js`
- `generateSocietyQR` — Returns a signed, expiring QR payload for the society bin
  - Token is stored in `societies.qr_code_token` + `qr_expires_at`
  - QR contains: `{ societyId, token, generatedAt }`
- `scanQR` — Universal QR scan endpoint (role-aware):
  - If **Secretary** scans → shows bin status options (Full / Partially Full / Overflow)
  - If **Driver** scans → shows task action (Complete / Reject), requests photo upload + extracts GPS from device

#### [NEW] `src/routes/qrRoutes.js`
- `GET /api/qr/generate/:societyId` — Secretary/Admin
- `POST /api/qr/scan` — Secretary (raise complaint) or Driver (complete task)
  - Body: `{ token, action, binStatus? }` 
  - Role determined from JWT

---

### Component 4 — Bin Complaint Queue & Smart Driver Assignment

#### [NEW] `src/controllers/binComplaintController.js`
- `raiseBinComplaint` — Secretary raises complaint after QR scan
  - Determines if duty time is active (06:00–13:00)
  - If active: immediately queue for today
  - If outside duty window: store with `scheduled_date = tomorrow`
- `getBinComplaints` — Admin: all complaints; Secretary: their society's complaints
- `autoAssignDrivers` — Called by a scheduled job or admin trigger
  - Fetches all `Queued` complaints for today
  - Sorts by time raised (FIFO)
  - Distributes **equally** across available drivers (round-robin)
  - Calculates estimated time between stops using Haversine distance
  - Creates `driver_tasks` rows
- `getDriverDailyTasks` — Driver sees their ordered task list for the day
- `updateTaskStatus` — Driver marks task Complete/Reject (requires photo + GPS validation)

#### [NEW] `src/routes/binComplaintRoutes.js`
- `POST /api/bin-complaints` — Secretary only  
- `GET /api/bin-complaints` — Admin/Secretary
- `POST /api/bin-complaints/auto-assign` — Admin trigger
- `GET /api/bin-complaints/driver/tasks` — Driver only
- `PATCH /api/bin-complaints/tasks/:taskId/complete` — Driver + photo upload
- `PATCH /api/bin-complaints/tasks/:taskId/reject` — Driver

---

### Component 5 — GPS Verification for Driver Completion

#### [MODIFY] `src/controllers/binComplaintController.js` — `updateTaskStatus`
When driver marks task as complete:
1. Extract GPS from **request body** (device live coordinates, NOT EXIF from image)
2. Fetch the society's bin coordinates (from `bin_complaints` → `societies` → lat/lng)
3. Calculate distance between driver GPS and bin location
4. If distance > 200 meters → flag as `is_location_verified = false`, still accept but log discrepancy
5. If within 200m → `is_location_verified = true`
6. Upload proof photo to Cloudinary → `completion_photo_url`
7. Award carbon points to the society

---

### Component 6 — Throw Event Logging (Individual Tracking)

#### [NEW] `src/controllers/throwEventController.js`
- `logThrowEvent` — Citizen logs "I threw garbage today"
  - Validates an active collection window exists (driver task is `InProgress` for their society)
  - Geo-fence check: citizen device GPS must be within 200m of the bin
  - Each citizen can only log once per collection event
  - Awards individual points to their Carbon Card
- `getThrowHistory` — Citizen's own throw log

#### [NEW] `src/routes/throwEventRoutes.js`
- `POST /api/throw-events` — Citizen only
- `GET /api/throw-events/my-history` — Citizen

---

### Component 7 — Carbon Card System

#### [NEW] `src/controllers/carbonCardController.js`
- `getMyCarbonCard` — Returns citizen's total/available/redeemed points + tier
- `getLeaderboard` — Top societies and top individual citizens by carbon points
- `redeemPoints` — Citizen redeems points:
  - Input: `{ redemptionType, pointsToUse }`
  - Validates available balance
  - Generates a unique `voucher_code`
  - Creates PDF voucher (basic HTML→PDF using built-in Buffer, no new lib needed)
  - Uploads to Cloudinary and returns download URL
  - Deducts from `available_points`
- `getSocietyCarbonCard` — Society's aggregate carbon card view with flat-wise breakdown
- `initializeCarbonCard` — Auto-called on citizen signup (creates empty card)

#### [NEW] `src/routes/carbonCardRoutes.js`
- `GET /api/carbon-card/me` — Citizen
- `GET /api/carbon-card/society/:id` — Secretary/Admin
- `POST /api/carbon-card/redeem` — Citizen
- `GET /api/carbon-card/leaderboard` — Public

---

### Component 8 — Carbon Points Award Logic

#### [NEW] `src/utils/carbonPointsEngine.js`
Centralized utility for calculating carbon point awards.

```
Society gets points on bin pickup completion:
  base_points = 100
  fill_multiplier = fill_level / 100  (0.5 for 50% full, 1.0 for full)
  society_points = round(base_points × fill_multiplier)

Individual throw event:
  base_throw_points = 10 (flat rate per confirmed throw)

Society points redistribution:
  - Count citizens who threw during the collection window
  - Each qualifying citizen gets: society_points / qualifying_count (rounded down)
  - Any remainder goes to secretary as bonus
```

**Tier Calculation:**
| Points | Tier |
|--------|------|
| 0–499 | 🥉 Bronze |
| 500–1999 | 🥈 Silver |
| 2000–4999 | 🥇 Gold |
| 5000+ | 💎 Platinum |

---

### Component 9 — Citizen Signup Enhancement

#### [MODIFY] `src/controllers/authCitizenController.js`
- After successful citizen signup (both email and Google), auto-call `initializeCarbonCard(citizenId)`
- This creates an empty carbon card row for the citizen

---

### Component 10 — app.js Route Registration

#### [MODIFY] `src/app.js`
Register 5 new route groups:
```js
import societyRoutes from './routes/societyRoutes.js';
import qrRoutes from './routes/qrRoutes.js';
import binComplaintRoutes from './routes/binComplaintRoutes.js';
import throwEventRoutes from './routes/throwEventRoutes.js';
import carbonCardRoutes from './routes/carbonCardRoutes.js';

app.use('/api/societies', societyRoutes);
app.use('/api/qr', qrRoutes);
app.use('/api/bin-complaints', binComplaintRoutes);
app.use('/api/throw-events', throwEventRoutes);
app.use('/api/carbon-card', carbonCardRoutes);
```

---

## Complete Workflow Sequence Diagram

```
Secretary scans QR (on dustbin)
    ↓
POST /api/qr/scan  {token, action:'report', binStatus:'full'}
    ↓
binComplaintController.raiseBinComplaint()
    • Is duty time active? (06:00–13:00)
      YES → status='Queued', scheduled_date=today
      NO  → status='Queued', scheduled_date=tomorrow
    ↓
Admin Panel / Scheduled Trigger
POST /api/bin-complaints/auto-assign
    • Fetch all Queued complaints for today
    • Round-robin assign to available drivers (equal distribution)
    • Create driver_tasks rows with sequence_order
    ↓
Driver opens app (morning)
GET /api/bin-complaints/driver/tasks
    • Sees ordered list of societies to visit today
    ↓
Driver arrives at society → scans QR on dustbin
POST /api/qr/scan  {token, action:'complete', driverLat, driverLng}
    • Role=driver → shows Complete/Reject options
    ↓
Driver submits: PATCH /api/bin-complaints/tasks/:id/complete
    • Upload photo → Cloudinary
    • GPS verify (within 200m of society bin)
    • Mark task Completed
    • Award Carbon Points to society
    • Open 30-min throw window
    ↓
Citizens in that society
POST /api/throw-events  {societyId, citizenLat, citizenLng}
    • Geo-fence check (within 200m)
    • Award 10 individual points to citizen Carbon Card
    ↓
Society carbon points redistributed equally among all who threw
    ↓
Citizens redeem points
POST /api/carbon-card/redeem  {redemptionType, pointsToUse}
    • Generate voucher code + PDF → Cloudinary
    • Return download URL
```

---

## Verification Plan

### Manual API Testing (Postman)
1. Register a society, assign secretary
2. Secretary scans QR → raises bin complaint
3. Trigger auto-assign → verify equal driver distribution
4. Driver fetches tasks, marks complete with photo + GPS
5. Citizen logs throw event within window
6. Check carbon card balance updated
7. Redeem points → voucher generated

### DB Verification
- All 7 new tables created in Supabase with correct FKs
- Carbon card auto-created on citizen signup

### Edge Cases Covered
- Complaint raised outside duty hours → goes to tomorrow's queue
- Driver GPS > 200m from bin → flagged but not blocked
- Citizen throws after window closes → rejected
- Citizen tries to throw twice → rejected (unique constraint per collection event)
- QR token expired → regenerate required
