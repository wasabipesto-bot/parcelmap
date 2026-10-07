// Builds EasyPost-shaped USPS trackers from a small spec, with scan times
// relative to "now", for tests and the local mock server.

const loc = (l) => ({ object: "TrackingLocation", city: l?.city ?? null, state: l?.state ?? null, country: l ? "US" : null, zip: l?.zip ?? null });

// [status, message, where] in journey order; where is a key into the spec.
const JOURNEY = [
  ["pre_transit", "Shipping Label Created, USPS Awaiting Item", "origin"],
  ["in_transit", "USPS picked up item", "origin"],
  ["in_transit", "Arrived at USPS Regional Origin Facility", "originFacility"],
  ["in_transit", "Departed USPS Regional Facility", "originFacility"],
  ["in_transit", "In Transit to Next Facility", null],
  ["in_transit", "Arrived at USPS Regional Destination Facility", "hub"],
  ["in_transit", "Departed USPS Regional Facility", "hub"],
  ["in_transit", "Arrived at Post Office", "dest"],
  ["out_for_delivery", "Out for Delivery", "dest"],
  ["delivered", "Delivered, Front Door/Porch", "dest"],
];
const STOP = {
  label: 1,
  accepted: 2,
  origin_facility: 4,
  in_transit: 5,
  dest_facility: 6,
  out_for_delivery: 9,
  delivered: 10,
};
const HOUR = 3600_000;

export function buildTracker(spec, pkg, now = Date.now()) {
  const places = { origin: spec.origin, originFacility: spec.originFacility, hub: pkg.hub, dest: pkg };
  let steps = JOURNEY.slice(0, STOP[pkg.stage] ?? 8);
  if (pkg.stage === "available_for_pickup") steps = [...JOURNEY.slice(0, 8), ["available_for_pickup", "Available for Pickup", "dest"]];
  if (pkg.stage === "return_to_sender") steps = [...JOURNEY.slice(0, 6), ["return_to_sender", "Return to Sender Processed", "hub"]];
  const details = steps.map(([status, message, where], i) => ({
    object: "TrackingDetail",
    status,
    status_detail: status === "delivered" ? "arrived_at_destination" : "status_update",
    message: where === "dest" && status === "delivered" ? `${message}, ${pkg.city} ${pkg.state} ${pkg.zip}` : message,
    description: "",
    datetime: new Date(now - (steps.length - i) * 3 * HOUR + 40 * 60_000).toISOString().replace(/\.\d+Z$/, "Z"),
    source: "USPS",
    tracking_location: loc(where ? places[where] : null),
  }));
  const status = steps.at(-1)[0];
  return {
    id: pkg.id,
    object: "Tracker",
    mode: "test",
    tracking_code: `9400100000000000${pkg.id.replace(/\D/g, "").padStart(6, "0")}`,
    status,
    status_detail: details.at(-1).status_detail,
    signed_by: status === "delivered" ? "J DOE" : null,
    weight: 16,
    est_delivery_date: new Date(now + 2 * 24 * HOUR).toISOString().slice(0, 10) + "T00:00:00Z",
    carrier: "USPS",
    tracking_details: details,
    carrier_detail: {
      object: "CarrierDetail",
      service: "Priority Mail",
      origin_location: `${spec.origin.city} ${spec.origin.state}, ${spec.origin.zip}`,
      destination_location: `${pkg.city} ${pkg.state}, ${pkg.zip}`,
    },
    public_url: `https://track.easypost.com/${pkg.id}`,
  };
}
