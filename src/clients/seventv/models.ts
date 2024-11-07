export interface Emote {
  animated: boolean;
  flags: number;
  host: {
    url: string;
    files: string[];
  };
  id: string;
  lifecycle: number;
  listed: boolean;
  name: string;
  owner: null;
  state: [];
  tags: [];
  versions: [];
}

export interface EmoteFile {
  name: string;
  static_name: string;
  width: number;
  height: number;
  frame_count: number;
  size: number;
  format: string;
}
