import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

const MAX_UPLOAD_SIZE = 2048;

/** Scales a picked photo down for upload and returns it as a JPEG data URL. */
async function toDataUrl(asset: ImagePicker.ImagePickerAsset): Promise<string> {
  const context = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > MAX_UPLOAD_SIZE) {
    context.resize(asset.width >= asset.height ? { width: MAX_UPLOAD_SIZE } : { height: MAX_UPLOAD_SIZE });
  }
  const image = await context.renderAsync();
  const { base64 } = await image.saveAsync({ base64: true, compress: 0.9, format: SaveFormat.JPEG });
  return `data:image/jpeg;base64,${base64}`;
}

/** Lets the user pick photos (or take one) and returns them ready to upload; empty when cancelled. */
export async function pickPhotos(source: "library" | "camera", { multiple = true } = {}): Promise<string[]> {
  if (source === "camera" && !(await ImagePicker.requestCameraPermissionsAsync()).granted) {
    throw new Error("Camera access is needed to take a photo.");
  }
  const result = source === "camera"
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"] })
    : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: multiple });
  return result.canceled ? [] : Promise.all(result.assets.map(toDataUrl));
}
