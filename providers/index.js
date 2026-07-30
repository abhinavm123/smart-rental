import { bookingCom18Provider } from "./booking-com18.js";

const providers = new Map([
  [bookingCom18Provider.id, bookingCom18Provider]
]);

export function getRentalProvider(value = process.env.RENTAL_PROVIDER) {
  const id = String(value || bookingCom18Provider.id).trim().toLowerCase();
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(
      `Unknown RENTAL_PROVIDER "${id}". Available providers: ${[...providers.keys()].join(", ")}.`
    );
  }
  return provider;
}

export function getRentalProviderIds() {
  return [...providers.keys()];
}
