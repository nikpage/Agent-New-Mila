/**
 * Google Maps service for travel time calculations
 */

export interface TravelTimeResult {
  durationSeconds: number
  durationText: string
  distanceMeters: number
  distanceText: string
}

export interface Location {
  address?: string
  lat?: number
  lng?: number
}

/**
 * Get travel time between two locations
 */
export async function getTravelTime(
  origin: string,
  destination: string,
  mode: 'driving' | 'walking' | 'transit' | 'bicycling' = 'driving',
  departureTime?: Date
): Promise<TravelTimeResult | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY

  if (!apiKey) {
    console.error('GOOGLE_MAPS_API_KEY not configured')
    return null
  }

  const params = new URLSearchParams({
    origins: origin,
    destinations: destination,
    mode,
    key: apiKey,
  })

  if (departureTime) {
    params.append('departure_time', Math.floor(departureTime.getTime() / 1000).toString())
  }

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`,
      { signal: AbortSignal.timeout(8_000) }
    )

    if (!response.ok) {
      throw new Error(`Maps API error: ${response.status}`)
    }

    const data = await response.json()

    if (data.status !== 'OK') {
      console.error('Maps API error:', data.status, data.error_message)
      return null
    }

    const element = data.rows?.[0]?.elements?.[0]

    if (!element || element.status !== 'OK') {
      return null
    }

    return {
      durationSeconds: element.duration.value,
      durationText: element.duration.text,
      distanceMeters: element.distance.value,
      distanceText: element.distance.text,
    }
  } catch (error) {
    console.error('Failed to get travel time:', error)
    return null
  }
}

/**
 * Calculate if there's enough travel time between two events
 */
export async function hasEnoughTravelTime(
  fromLocation: string,
  toLocation: string,
  availableMinutes: number,
  mode: 'driving' | 'walking' | 'transit' = 'driving',
  bufferMinutes: number = 10
): Promise<{ hasEnough: boolean; neededMinutes: number; travelTime: TravelTimeResult | null }> {
  const travelTime = await getTravelTime(fromLocation, toLocation, mode)

  if (!travelTime) {
    // If we can't calculate, assume it's fine
    return { hasEnough: true, neededMinutes: 0, travelTime: null }
  }

  const neededMinutes = Math.ceil(travelTime.durationSeconds / 60) + bufferMinutes
  const hasEnough = availableMinutes >= neededMinutes

  return { hasEnough, neededMinutes, travelTime }
}

/**
 * Get travel time in a human-readable format
 */
export function formatTravelTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.ceil((seconds % 3600) / 60)

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

/**
 * Geocode an address to coordinates
 */
export async function geocodeAddress(
  address: string
): Promise<{ lat: number; lng: number; formattedAddress: string } | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY

  if (!apiKey) {
    console.error('GOOGLE_MAPS_API_KEY not configured')
    return null
  }

  const params = new URLSearchParams({
    address,
    key: apiKey,
  })

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`
    )

    if (!response.ok) {
      throw new Error(`Geocoding API error: ${response.status}`)
    }

    const data = await response.json()

    if (data.status !== 'OK' || !data.results?.[0]) {
      return null
    }

    const result = data.results[0]

    return {
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      formattedAddress: result.formatted_address,
    }
  } catch (error) {
    console.error('Failed to geocode address:', error)
    return null
  }
}

/**
 * Calculate departure time needed to arrive on time
 */
export async function calculateDepartureTime(
  origin: string,
  destination: string,
  arrivalTime: Date,
  mode: 'driving' | 'walking' | 'transit' = 'driving',
  bufferMinutes: number = 10
): Promise<Date | null> {
  const travelTime = await getTravelTime(origin, destination, mode)

  if (!travelTime) {
    return null
  }

  const totalSeconds = travelTime.durationSeconds + bufferMinutes * 60
  const departureTime = new Date(arrivalTime.getTime() - totalSeconds * 1000)

  return departureTime
}
