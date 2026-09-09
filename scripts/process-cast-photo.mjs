import { Jimp } from "jimp";

const [, , inputPath, outputPath, size] = process.argv;
const target = Number(size) || 240;

const img = await Jimp.read(inputPath);
const { width, height } = img.bitmap;
const cropSize = Math.min(width, height);
const x = Math.round((width - cropSize) / 2);
const y = Math.round((height - cropSize) / 2);

img.crop({ x, y, w: cropSize, h: cropSize }).resize({ w: target, h: target });
await img.write(outputPath);
console.log("wrote " + outputPath + " (" + target + "x" + target + ")");
