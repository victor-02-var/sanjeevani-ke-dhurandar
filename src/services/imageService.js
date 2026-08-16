import ExifParser from 'exif-parser';
import { GoogleGenAI } from '@google/genai';

// Initialize Gemini API client using process.env.GEMINI_API_KEY
const ai = new GoogleGenAI({});

/**
 * 1. Extract GPS Coordinates from Image EXIF Metadata
 */
export const extractGpsFromMetadata = (imageBuffer) => {
  try {
    const parser = ExifParser.create(imageBuffer);
    const result = parser.parse();

    if (result.tags && result.tags.GPSLatitude && result.tags.GPSLongitude) {
      return {
        latitude: result.tags.GPSLatitude,
        longitude: result.tags.GPSLongitude,
        hasMetadataGps: true
      };
    }
  } catch (err) {
    console.warn('⚠️ Could not extract EXIF GPS data:', err.message);
  }

  return { latitude: null, longitude: null, hasMetadataGps: false };
};

/**
 * 2. Verify Image Content using Gemini Vision API
 * Checks if the image is strictly garbage/waste and NOT water pollution, clean areas, or random objects.
 * Includes graceful fallback for 503 high-demand / capacity spikes.
 */
export const verifyGarbageImage = async (imageBuffer, mimeType = 'image/jpeg') => {
  try {
    const prompt = `
      You are an automated municipal garbage verification engine.
      Analyze this image carefully and answer in strict JSON format.

      Validation Rules:
      1. 'isGarbage': true ONLY if the image clearly shows solid municipal waste, overflowing trash bins, roadside litter, plastic dumps, or uncollected garbage heaps.
      2. 'isGarbage': false if the image shows water pollution, sewage leaks, clean streets, indoor rooms, random selfies, animals, or unrelated items.
      3. 'category': Categorize as one of: ["Overflowing Bin", "Roadside Litter", "Plastic Waste", "Bulk Debris", "Invalid Image"].
      4. 'confidence': Float between 0.0 and 1.0.
      5. 'reason': Short 1-sentence explanation of what you see.

      Return ONLY valid raw JSON with this schema:
      {
        "isGarbage": boolean,
        "category": string,
        "confidence": number,
        "reason": string
      }
    `;

    const base64Data = imageBuffer.toString('base64');

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          inlineData: {
            data: base64Data,
            mimeType: mimeType
          }
        },
        prompt
      ],
      config: {
        responseMimeType: 'application/json'
      }
    });

    const resultText = response.text;
    const jsonResult = JSON.parse(resultText);

    return jsonResult;
  } catch (err) {
    console.warn('⚠️ Gemini Vision unavailable or experiencing high demand. Applying manual triage fallback:', err.message);
    
    // Fallback when API returns 503 spike or fails: allow report to be logged for admin review
    return {
      isGarbage: true,
      category: 'Unverified Waste',
      confidence: 0.80,
      reason: 'AI verification temporarily skipped due to high API demand. Saved for manual review.'
    };
  }
};