import { formatCapacity, parseCapacity } from '../../src/shared/providers/capacity'

/** [typed, parsed, formatted] for each input. */
export function capacityRoundTrip(inputs: string[]): Array<[string, number | undefined, string]> {
  return inputs.map(text => {
    const value = parseCapacity(text)
    return [text, value, value === undefined ? '' : Number.isNaN(value) ? 'NaN' : formatCapacity(value)]
  })
}
