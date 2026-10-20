import { MAX_IMAGE_BYTES, storeBoardImage, deleteBoardImage } from "./board-images";

export const MAX_LOGO_BYTES = MAX_IMAGE_BYTES;
export const storeBoardLogo = (env: Env, file: File) => storeBoardImage(env, file, "board-logos");
export const deleteBoardLogo = (env: Env, url: string | null) => deleteBoardImage(env, url, "board-logos");
