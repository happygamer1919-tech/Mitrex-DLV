# Booking guide for Mitrex (Maria)

Portal: https://portal.dlvlogistics.com . All times are Eastern (ET).

## Sign in
1. Open the portal and enter your email. Tap **Send code**.
2. Open the email "Your DLV sign-in code" and type the 8 digit code. It signs you in by itself on the last digit (or tap **Sign in**).
3. No email after 30 seconds? Tap **Resend code** (it counts down from 30 first). Check spam. A wrong or expired code also needs **Resend code**.
4. The email also has a link. It works too, but open it in the same browser where you asked for the code.

## Book a load
1. Tap **Book a load** in the top menu.
2. **Pickup**: choose the location. The contact name and phone fill in; change them if needed. Tick "Save as default for this location" to keep them.
3. Choose **Appointment** (one fixed time) or **Time window** (from and to). Set the date.
4. Do the same for **Delivery**.
5. **Equipment**: tap the truck size (26, 36 or 53 feet).
6. Moffett (forklift on truck): tick it if needed. Some locations, such as SAMIH, require it. Then it is ticked and locked, with a note saying why.
7. Optional: weight, pieces, PO number, notes.
8. **Trucks**: at the bottom, choose how many trucks (1 to 10) with the plus and minus buttons. Every truck becomes its own load with the same details and its own request reference. Leave it at 1 for a single load.
9. Tap **Request load** (it reads **Request 4 loads** for 4 trucks). You land on **Loads** with the new requests listed.

## Your load number
- Right after you request a load it shows **Number pending**, with a small grey line "Request MTX-0005". MTX-0005 is only DLV's internal reference for your request. DLV dispatches in ITS, so the official number does not exist yet.
- When DLV books the load, the number changes to the **ITS load number** (for example 313, or 313-2 for a split). From then on that number is the load's name on your screen, on the carrier's screen and in every email.
- Use the ITS number when you talk to dispatch about a booked load. Use "Request MTX-0005" while it still says Number pending.

## The booking email
When DLV books a load, every person in your company who uses the portal gets ONE email "Load 313 booked" with the carrier, the pickup and delivery places and times (ET), the contacts, the truck size and a link to the load. The BOL is attached to that email as BOL-313.pdf. If the BOL is not uploaded yet the email says "The BOL will follow once uploaded", and when DLV uploads it later you get a second email "BOL for load 313" with the file. A very large BOL is not attached: the email then says "The BOL is available in the app" with the link. You get no other status emails: pickup, enroute and delivered stay in the app.

## Book the same load again
1. Tap **Loads**, then **Completed**. These are your delivered loads, newest first, each with its delivered date.
2. Tap **Request again** on a load (or open the load and tap **Request again** at the top).
3. The booking form opens with the same locations, contacts, truck size, Moffett, weight, pieces, PO number and notes. Only the dates and times are empty, because every shipment needs new ones. A blue note says which load was copied. Tap **Dismiss** to hide it.
4. Choose the dates and times, change anything else if needed, and tap **Request load**. You can also set several trucks at the bottom.
5. Cancelled loads cannot be requested again.

## Book a return
Use this when the site asks the same truck to take the empty frames back, to Mitrex (or the shipper the load came from) or to a scrapyard.
1. Open the load (or find it in **Loads**). A **Return** button shows once the truck is **At delivery** or the load is **Delivered**.
2. Tap **Return**. The booking form opens turned around: the truck reloads at the site where it delivered (shown, it cannot be changed), with the site contact from the first load already filled in.
3. **Delivery location** starts on the place the load came from, marked "(original shipper)", with the contact from the first load. To send the frames somewhere else, for example a scrapyard, choose it in the list: its saved contact fills in.
4. Truck size, Moffett, weight, pieces, PO number and notes are copied. Change anything you need.
5. Choose the new dates and times and tap **Request return**. A return is always one truck.
6. The new load says "Return of <first load>" with a link back, and the first load lists it under "Return loads". If you open Return again on the same load, a note says a return was already requested; you can still book another one if the site needs a second truck.

## Who was the contact last time
Under each contact name and phone, the form shows "Last contact at <place>: <name>, <phone> (load number, date)", where the load number is the ITS number, or "Request MTX-0005" for a load that has none. It is the contact on your most recent load to or from that place.
- **Use last contact** fills in that name and phone.
- **Same as last time** means the fields already match.
- "No earlier load here. Using the saved default contact." means you have not shipped to or from that place yet, and the place's saved contact is used.
Edit the fields freely. Tick "Save as default for this location" to keep the new contact for the place.

## Change or cancel
- While the status is Requested you can tap **Edit load** then **Save changes**, or **Cancel load** then **Yes, cancel this load**. Cancelling cannot be undone.
- After DLV books it, the page says "Contact DLV to change this load". Call or email dispatch (below).
- When DLV changes something for you (a place, a contact, a date, the truck size), your load page shows the new details by itself and the Timeline says "Details edited:" with what changed. No email is sent for this.

## What each status means
- **Requested**: sent, DLV has not booked a truck yet.
- **Booked**: a carrier is assigned and the ITS load number exists. You get the booking email.
- **At pickup**: the driver is at the pickup location.
- **Loading**: the truck is being loaded.
- **Enroute**: the truck left for delivery. The ETA shows.
- **At delivery**: the truck is at the delivery location.
- **Delivered**: done. The POD is available once the carrier or DLV uploads it. Until then the load says **POD not uploaded yet.**
- **Cancelled**: the load will not move.

Pages update by themselves.

## Find a load in your list
Your **Loads** list has three groups. Tap a group title to open or close it.
- **Active**: everything not delivered or cancelled. It is open.
- **Delivered**: closed at first. It holds the loads delivered in the last 30 days, newest first. Tap **Show older (25 more)** for older ones (also when it says "No deliveries in the last 30 days.").
- **Cancelled**: closed at first, newest first, **Show older** for more.
- **Request again** and **Return** sit right on the row, no need to open anything.
- Tap **Filters** to search (load number, request number, PO, pickup or delivery place, carrier), or to choose a status, shipper, receiver, truck size or pickup date (Today, Tomorrow, Next 7 days or your own dates). Tap **Apply**.
- **Sort by** pickup time (the normal order), date requested, date delivered, shipper or receiver, and choose up or down.
- Each filter shows as a chip under the box: tap a chip to remove it, or **Clear all**. A search looks through all your loads, also the old delivered ones.
- The quick buttons **Today**, **Tomorrow** and **Next 7 days** filter by pickup date in one tap.

## Download your loads (CSV)
On **Loads** tap **Export CSV**. Choose the dates (by pickup date or by the date you requested the load) and, if you want, some statuses. Tap **Download CSV**. The file opens in Excel and holds only your loads.

## Find ETA, BOL and POD
Open the load from the **Loads** list.
- **ETA**: under "Load details" once the truck is enroute, and on the list.
- **BOL**: under **Documents**, button **Download BOL**. It appears after DLV uploads it, and it is attached to the booking email.
- **POD**: under **Documents**, button **View POD**, once it is uploaded. A load can be delivered before the POD photo arrives: the page then says **POD not uploaded yet.** and the button appears by itself (within about 15 seconds) when it is added.
- The **Timeline** shows the latest 3 changes. Tap **Show all ... events** to see every status change.

## Photos of your load
The driver takes two photos with the app's own camera: the freight loaded on the truck, and the freight at delivery. The time on each photo is set by DLV, not by the driver's phone.
- Open the load from the **Loads** list and look at the **Photos** card.
- The photo of the loaded freight appears once the truck has left for delivery (**Enroute** or later).
- The delivery photo appears once the load is **Delivered**.
- Tap a photo to open it full size. Each photo shows the date and time (Eastern time).
- The card shows up to 4 photos. When there are more, tap **Show all ... photos**.
- Before that the card tells you when the photos will appear. The page updates by itself.
- You only see the photos of your own loads. You cannot add or remove photos; ask DLV if one is missing.

## Add or change a location
You are in charge of your locations. You do not need to ask DLV: every change is saved at once.

Add a new location:
1. Open **Locations** in the top menu and tap **Add location** (at the top of the page, or scroll to the form at the bottom).
2. Fill in the location name, the street address, the city and the province (two letters, for example ON). The postal code is optional.
3. Tick what happens there: **Can ship (pickup)**, **Can receive (delivery)** or both. Tick **Needs a Moffett** if a Moffett is needed to load or unload there.
4. Optional: a default contact name and phone (they fill in by themselves when you book), and notes (up to 1000 characters).
5. Tap **Add location**. The page says "<name> was added. You can book with it now." It is in the booking form straight away.

Change a location:
1. On **Locations**, tap **Edit** on the location.
2. Change any field: name, address, city, province, postal code, can ship, can receive, Moffett, default contact, notes.
3. Tap **Save changes**. The page says "Saved." Tap **Cancel** to leave without saving.

Good to know:
- The booking form follows your changes at once. A place that no longer ships is not offered as a pickup; a place that needs a Moffett ticks and locks the Moffett box.
- A changed address also shows on loads that already use that location. If a load is already on its way, call DLV as well.
- Each location needs a name that no other location has. If the name is taken the form says "A location with this name already exists."
- Only DLV can switch a location off or remove it. Ask DLV if a place is no longer used.
- Requests you sent before this change are listed under "Requests waiting for DLV" until DLV answers them.

## Rates: ask for a price on a new lane
Use this when you need a price for a lane that DLV does not have yet. It does not book a load.
1. Tap **Rates** in the top menu.
2. Under **Request a rate** fill in the pickup city and state (for example Toronto, ON), the delivery city and state (for example Buffalo, NY) and tap the truck size (26, 36 or 53 ft). Weight, dimensions and notes are optional.
3. Tap **Request a rate**. The page says "Rate request RQ-0001 sent". DLV is emailed.
4. When DLV has entered the rate you get an email "Your rate is ready in the app". The email does not show the price: open **Rates** in the portal to see it.
5. Under **Your rate requests** each request shows **Waiting for rate**, **Rate ready** or **Cancelled**. A request with **Rate ready** shows the amount and currency, DLV's notes and the date it is valid until. Tap **Book this lane** to go to the booking page and book the load as usual.
6. Asked by mistake? Tap **Cancel request** on a request that is still **Waiting for rate**. Once the rate is ready it can no longer be cancelled.
If a field is wrong the page tells you which one (for example the state must be a two letter code like ON or NY), and keeps what you typed.

## Who to contact
DLV dispatch: (226) 703-3034, chris@dlvlogistics.com
