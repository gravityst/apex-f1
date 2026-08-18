/**
 * APEX F1 — Constructors, drivers and liveries.
 * Every team, driver, sponsor and engine name here is INVENTED.
 * Any resemblance to a real-world racing organisation is coincidental.
 */

export const TEAMS = [
  {
    id: 'velocitas',
    name: 'Velocitas Racing',
    short: 'VLC',
    engine: 'Velocitas RA-9',
    base: 'Aldersgate, UK',
    colors: { primary: '#12224a', secondary: '#d8202f', accent: '#f2c53d', trim: '#ffffff' },
    livery: 'bolt',
    performance: 0.99,   // 0..1 baseline car pace
    reliability: 0.97,
    sponsors: ['ORAVAX', 'KINETIQ', 'NOVAFUEL'],
    drivers: [
      { num: 1, name: 'Kai Renner', short: 'REN', country: 'NL', skill: 0.98, aggression: 0.86, consistency: 0.96, wet: 0.95, helmet: { base: '#12224a', stripe: '#f2c53d', visor: '#1a1a1a' } },
      { num: 22, name: 'Tomás Aldair', short: 'ALD', country: 'MX', skill: 0.90, aggression: 0.70, consistency: 0.92, wet: 0.88, helmet: { base: '#d8202f', stripe: '#ffffff', visor: '#2a2a2a' } },
    ],
  },
  {
    id: 'argentum',
    name: 'Argentum Motorworks',
    short: 'ARG',
    engine: 'Argentum HX-6',
    base: 'Bracklowe, UK',
    colors: { primary: '#b9c4cc', secondary: '#0a0e12', accent: '#00d7b1', trim: '#ffffff' },
    livery: 'arrow',
    performance: 0.96,
    reliability: 0.98,
    sponsors: ['HELION', 'STRATOS', 'AQUEVA'],
    drivers: [
      { num: 44, name: 'Elias Vance', short: 'VAN', country: 'GB', skill: 0.97, aggression: 0.74, consistency: 0.97, wet: 0.99, helmet: { base: '#00d7b1', stripe: '#0a0e12', visor: '#111111' } },
      { num: 63, name: 'Rory McKellen', short: 'MCK', country: 'GB', skill: 0.91, aggression: 0.79, consistency: 0.90, wet: 0.89, helmet: { base: '#b9c4cc', stripe: '#d8202f', visor: '#1a1a1a' } },
    ],
  },
  {
    id: 'scuderia',
    name: 'Rossa Corsa',
    short: 'RSC',
    engine: 'Rossa Tipo-88',
    base: 'Monteverdi, IT',
    colors: { primary: '#c8102e', secondary: '#1a1a1a', accent: '#f7e600', trim: '#ffffff' },
    livery: 'prancing',
    performance: 0.97,
    reliability: 0.93,
    sponsors: ['MARANO', 'VESPRA', 'TERRAFIN'],
    drivers: [
      { num: 16, name: 'Luca Bertolini', short: 'BER', country: 'MC', skill: 0.95, aggression: 0.83, consistency: 0.89, wet: 0.92, helmet: { base: '#c8102e', stripe: '#f7e600', visor: '#0d0d0d' } },
      { num: 55, name: 'Diego Salvarez', short: 'SAL', country: 'ES', skill: 0.92, aggression: 0.76, consistency: 0.93, wet: 0.87, helmet: { base: '#f7e600', stripe: '#c8102e', visor: '#1a1a1a' } },
    ],
  },
  {
    id: 'meridian',
    name: 'Meridian Grand Prix',
    short: 'MRD',
    engine: 'Argentum HX-6',
    base: 'Enstowe, UK',
    colors: { primary: '#00594f', secondary: '#f5f2e8', accent: '#ff6b00', trim: '#0a0a0a' },
    livery: 'chevron',
    performance: 0.93,
    reliability: 0.95,
    sponsors: ['CASTELL', 'BWX', 'AERONOVA'],
    drivers: [
      { num: 14, name: 'Mateo Cruz', short: 'CRU', country: 'ES', skill: 0.93, aggression: 0.72, consistency: 0.94, wet: 0.93, helmet: { base: '#00594f', stripe: '#ff6b00', visor: '#151515' } },
      { num: 18, name: 'Oscar Lindqvist', short: 'LIN', country: 'SE', skill: 0.88, aggression: 0.68, consistency: 0.91, wet: 0.84, helmet: { base: '#f5f2e8', stripe: '#00594f', visor: '#1a1a1a' } },
    ],
  },
  {
    id: 'aurora',
    name: 'Aurora Motorsport',
    short: 'AUR',
    engine: 'Velocitas RA-9',
    base: 'Faenholt, IT',
    colors: { primary: '#0090d4', secondary: '#0a2540', accent: '#ffffff', trim: '#ff2d55' },
    livery: 'wave',
    performance: 0.91,
    reliability: 0.90,
    sponsors: ['ZENTARA', 'PULSE', 'HYDRON'],
    drivers: [
      { num: 10, name: 'Pierre Vasseur', short: 'VAS', country: 'FR', skill: 0.89, aggression: 0.81, consistency: 0.87, wet: 0.90, helmet: { base: '#0090d4', stripe: '#ffffff', visor: '#101010' } },
      { num: 31, name: 'Anouk Delacroix', short: 'DEL', country: 'FR', skill: 0.87, aggression: 0.75, consistency: 0.89, wet: 0.86, helmet: { base: '#ff2d55', stripe: '#0a2540', visor: '#161616' } },
    ],
  },
  {
    id: 'monolith',
    name: 'Monolith Racing',
    short: 'MNL',
    engine: 'Monolith V6-T',
    base: 'Wolfsheim, DE',
    colors: { primary: '#1b3b2f', secondary: '#c9d600', accent: '#0f0f0f', trim: '#ffffff' },
    livery: 'blade',
    performance: 0.90,
    reliability: 0.94,
    sponsors: ['KRAFTWERK-9', 'OBSIDIAN', 'VOLTIC'],
    drivers: [
      { num: 4, name: 'Niklas Brandt', short: 'BRA', country: 'DE', skill: 0.90, aggression: 0.77, consistency: 0.92, wet: 0.88, helmet: { base: '#c9d600', stripe: '#1b3b2f', visor: '#0d0d0d' } },
      { num: 81, name: 'Sam Okonkwo', short: 'OKO', country: 'GB', skill: 0.86, aggression: 0.73, consistency: 0.88, wet: 0.85, helmet: { base: '#1b3b2f', stripe: '#ffffff', visor: '#141414' } },
    ],
  },
  {
    id: 'nimbus',
    name: 'Nimbus Racing Bulls',
    short: 'NMB',
    engine: 'Velocitas RA-9',
    base: 'Faenholt, IT',
    colors: { primary: '#1b4fa0', secondary: '#e8e8e8', accent: '#e4002b', trim: '#101010' },
    livery: 'shard',
    performance: 0.88,
    reliability: 0.91,
    sponsors: ['CASH-X', 'TITANIS', 'ORAVAX'],
    drivers: [
      { num: 3, name: 'Yuki Sorano', short: 'SOR', country: 'JP', skill: 0.86, aggression: 0.88, consistency: 0.82, wet: 0.83, helmet: { base: '#e4002b', stripe: '#1b4fa0', visor: '#0f0f0f' } },
      { num: 30, name: 'Liam Hartley', short: 'HAR', country: 'NZ', skill: 0.84, aggression: 0.71, consistency: 0.86, wet: 0.82, helmet: { base: '#1b4fa0', stripe: '#e8e8e8', visor: '#1a1a1a' } },
    ],
  },
  {
    id: 'halcyon',
    name: 'Halcyon Racing',
    short: 'HLC',
    engine: 'Argentum HX-6',
    base: 'Silverbrook, UK',
    colors: { primary: '#1fc4a0', secondary: '#0b1a2b', accent: '#ff8a00', trim: '#ffffff' },
    livery: 'crest',
    performance: 0.87,
    reliability: 0.92,
    sponsors: ['AERIS', 'NOVAFUEL', 'STRATOS'],
    drivers: [
      { num: 27, name: 'Jonas Reiter', short: 'REI', country: 'DE', skill: 0.85, aggression: 0.74, consistency: 0.87, wet: 0.86, helmet: { base: '#1fc4a0', stripe: '#0b1a2b', visor: '#121212' } },
      { num: 5, name: 'Andre Bassi', short: 'BAS', country: 'BR', skill: 0.83, aggression: 0.80, consistency: 0.84, wet: 0.88, helmet: { base: '#ff8a00', stripe: '#ffffff', visor: '#161616' } },
    ],
  },
  {
    id: 'cobalt',
    name: 'Cobalt Union',
    short: 'CBU',
    engine: 'Monolith V6-T',
    base: 'Hinwil Vale, CH',
    colors: { primary: '#00e07a', secondary: '#0d0d0d', accent: '#ffffff', trim: '#00e07a' },
    livery: 'circuit',
    performance: 0.85,
    reliability: 0.89,
    sponsors: ['STAKE-9', 'QUANTA', 'HELION'],
    drivers: [
      { num: 77, name: 'Viktor Nyland', short: 'NYL', country: 'FI', skill: 0.84, aggression: 0.69, consistency: 0.85, wet: 0.87, helmet: { base: '#00e07a', stripe: '#0d0d0d', visor: '#0f0f0f' } },
      { num: 24, name: 'Zhou Ming-Wei', short: 'ZHO', country: 'CN', skill: 0.81, aggression: 0.66, consistency: 0.86, wet: 0.80, helmet: { base: '#0d0d0d', stripe: '#00e07a', visor: '#181818' } },
    ],
  },
  {
    id: 'apexion',
    name: 'Apexion Works',
    short: 'APX',
    engine: 'Apexion RE-1',
    base: 'Grove Hollow, UK',
    colors: { primary: '#0b3d91', secondary: '#f5c518', accent: '#ffffff', trim: '#0b0b0b' },
    livery: 'stripe',
    performance: 0.84,
    reliability: 0.87,
    sponsors: ['KINETIQ', 'ORBITAL', 'VESPRA'],
    drivers: [
      { num: 23, name: 'Alex Marsden', short: 'MAR', country: 'TH', skill: 0.82, aggression: 0.72, consistency: 0.84, wet: 0.81, helmet: { base: '#0b3d91', stripe: '#f5c518', visor: '#141414' } },
      { num: 2, name: 'Logan Reyes', short: 'REY', country: 'US', skill: 0.80, aggression: 0.78, consistency: 0.80, wet: 0.78, helmet: { base: '#ffffff', stripe: '#0b3d91', visor: '#1a1a1a' } },
    ],
  },
];

/** Flat list of the 20 driver entries, each carrying a back-ref to its team. */
export const GRID = TEAMS.flatMap((team) =>
  team.drivers.map((d) => ({ ...d, team, teamId: team.id, teamName: team.name }))
);

export const TYRE_COMPOUNDS = {
  soft:   { name: 'Soft',         short: 'S', color: '#e8002d', grip: 1.00, wearRate: 1.55, warmup: 1.35, optimalTemp: 98,  tempWindow: 22 },
  medium: { name: 'Medium',       short: 'M', color: '#f5d800', grip: 0.965, wearRate: 1.00, warmup: 1.00, optimalTemp: 102, tempWindow: 26 },
  hard:   { name: 'Hard',         short: 'H', color: '#f0f0f0', grip: 0.935, wearRate: 0.68, warmup: 0.74, optimalTemp: 108, tempWindow: 32 },
  inter:  { name: 'Intermediate', short: 'I', color: '#43b02a', grip: 0.86, wearRate: 1.20, warmup: 1.10, optimalTemp: 82,  tempWindow: 28, wetGrip: 0.72, minWet: 0.15, maxWet: 0.72 },
  wet:    { name: 'Wet',          short: 'W', color: '#0067ad', grip: 0.74, wearRate: 1.05, warmup: 1.25, optimalTemp: 66,  tempWindow: 30, wetGrip: 1.00, minWet: 0.45, maxWet: 1.0 },
};

export function getTeam(id) { return TEAMS.find((t) => t.id === id) || TEAMS[0]; }
