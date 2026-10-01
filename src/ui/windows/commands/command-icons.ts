/**
 * The icons a command button can show, by the Lucide name a package gives. The set is small so
 * that the bundle carries only these; a name outside it draws the generic icon.
 *
 * @module
 */

import {
  CircleArrowOutUpLeftIcon,
  CompassIcon,
  CrosshairIcon,
  FlagIcon,
  GaugeIcon,
  HouseIcon,
  MapIcon,
  OctagonXIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  RouteIcon,
  SaveIcon,
  SquareIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Readonly<Record<string, LucideIcon>> = {
  'circle-arrow-out-up-left': CircleArrowOutUpLeftIcon,
  compass: CompassIcon,
  crosshair: CrosshairIcon,
  flag: FlagIcon,
  gauge: GaugeIcon,
  house: HouseIcon,
  map: MapIcon,
  'octagon-x': OctagonXIcon,
  pause: PauseIcon,
  play: PlayIcon,
  'rotate-ccw': RotateCcwIcon,
  route: RouteIcon,
  save: SaveIcon,
  square: SquareIcon,
  wrench: WrenchIcon,
  zap: ZapIcon,
};

/** The icon for a Lucide name, or the generic one. */
export function commandIcon(name: string | undefined): LucideIcon {
  return (name === undefined ? undefined : ICONS[name]) ?? ZapIcon;
}
