// Human names -> KiCad lib_ids for the parts the tool knows how to place.

export interface PartAlias {
  alias: string;
  libId: string;
  description: string;
  defaultValue?: string;
}

export const PART_ALIASES: PartAlias[] = [
  { alias: 'resistor', libId: 'Device:R', description: 'resistor, 2 leads', defaultValue: '1k' },
  { alias: 'capacitor', libId: 'Device:C', description: 'ceramic or film capacitor, 2 leads', defaultValue: '100n' },
  { alias: 'electrolytic capacitor', libId: 'Device:C_Polarized', description: 'polarised capacitor, + lead on pin 1', defaultValue: '10u' },
  { alias: 'inductor', libId: 'Device:L', description: 'inductor, 2 leads', defaultValue: '1m' },
  { alias: 'diode', libId: 'Diode:1N4148', description: 'small-signal diode, K on pin 1', defaultValue: '1N4148' },
  { alias: '1N4001', libId: 'Diode:1N4001', description: 'rectifier diode', defaultValue: '1N4001' },
  { alias: 'zener', libId: 'Device:D_Zener', description: 'Zener diode, K on pin 1', defaultValue: '5V1' },
  { alias: 'LED', libId: 'Device:LED', description: 'LED, K on pin 1, A on pin 2', defaultValue: 'LED' },
  { alias: 'switch', libId: 'Switch:SW_SPST', description: 'SPST switch', defaultValue: 'SW_SPST' },
  { alias: 'pushbutton', libId: 'Switch:SW_Push', description: 'momentary pushbutton', defaultValue: 'SW_Push' },
  { alias: 'DIP switch 4', libId: 'Switch:SW_DIP_x04', description: '4-position DIP switch', defaultValue: 'SW_DIP_x04' },
  { alias: 'DIP switch 8', libId: 'Switch:SW_DIP_x08', description: '8-position DIP switch', defaultValue: 'SW_DIP_x08' },
  { alias: 'potentiometer', libId: 'Device:R_Potentiometer', description: 'potentiometer, wiper on pin 2', defaultValue: '10k' },
  { alias: 'NPN', libId: 'Transistor_BJT:2N3904', description: 'NPN transistor TO-92 (E B C)', defaultValue: '2N3904' },
  { alias: 'PNP', libId: 'Transistor_BJT:2N3906', description: 'PNP transistor TO-92 (E B C)', defaultValue: '2N3906' },
  { alias: 'NMOS', libId: 'Transistor_FET:2N7000', description: 'N-channel MOSFET TO-92 (S G D)', defaultValue: '2N7000' },
  { alias: 'LM741', libId: 'Amplifier_Operational:LM741', description: 'single op-amp, DIP-8, split supply', defaultValue: 'LM741' },
  { alias: 'LM358', libId: 'Amplifier_Operational:LM358', description: 'dual op-amp, DIP-8', defaultValue: 'LM358' },
  { alias: 'LM324', libId: 'Amplifier_Operational:LM324', description: 'quad op-amp, DIP-14', defaultValue: 'LM324' },
  { alias: '555', libId: 'Timer:NE555P', description: '555 timer, DIP-8', defaultValue: 'NE555P' },
  { alias: '7-segment display', libId: 'Display_Character:D168K', description: '7-segment display, common cathode, 10 pins', defaultValue: 'D168K' },
  ...['00', '02', '04', '08', '10', '11', '20', '21', '27', '30', '32', '86', '47', '48', '74', '76', '90', '93', '138', '139', '151', '153', '157', '161', '164', '165', '174', '175', '193', '283'].map((code) => ({ alias: `74LS${code}`, libId: `74xx:74LS${code}`, description: `74LS${code} logic IC`, defaultValue: `74LS${code}` })),
  { alias: '+5V', libId: 'power:+5V', description: 'power symbol, connects to the +5V net' },
  { alias: '+12V', libId: 'power:+12V', description: 'power symbol' },
  { alias: '-12V', libId: 'power:-12V', description: 'power symbol' },
  { alias: 'GND', libId: 'power:GND', description: 'ground symbol' },
];

export function resolveAlias(name: string): PartAlias | undefined {
  const n = name.trim().toLowerCase();
  return PART_ALIASES.find((p) => p.alias.toLowerCase() === n || p.libId.toLowerCase() === n || p.libId.split(':')[1].toLowerCase() === n);
}
