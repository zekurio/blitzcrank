import * as ping from "./ping";
import * as status from "./status";
import * as jellyfin from "./jellyfin/jellyfin";
import * as sevenTv from "./7tv/7tv";

export const commands = {
  ping,
  status,
  jellyfin,
  "7tv": sevenTv,
};
