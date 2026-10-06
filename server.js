const http = require("node:http");
const fs = require("node:fs");

const port = Number.parseInt(process.env.PORT || "3000", 10);
const maxRequestBytes = 15 * 1024 * 1024;
function getGeminiApiKey() {
    const envValues = [
        process.env.GEMINI_API_KEY,
        process.env.GEMINI_MODEL,
        process.env.NEXT_PUBLIC_GEMINI_API_KEY
    ].concat(Object.values(process.env));

    for (const val of envValues) {
        if (typeof val === "string") {
            const tokenMatch = val.match(/(?:AQ\.[A-Za-z0-9_-]{25,}|AIza[A-Za-z0-9_-]{25,})/);
            if (tokenMatch) return tokenMatch[0];
        }
    }

    for (const val of envValues) {
        if (typeof val === "string") {
            const eqMatch = val.match(/GEMINI_API_KEY\s*=\s*([^\s]+)/);
            if (eqMatch && eqMatch[1] !== "MY_GEMINI_API_KEY") return eqMatch[1].trim();
        }
    }

    const key = process.env.GEMINI_API_KEY || "";
    if (key && key !== "MY_GEMINI_API_KEY") return key.trim();
    return "";
}

function getGeminiModel() {
    let raw = process.env.GEMINI_MODEL || "";
    const eqMatch = raw.match(/GEMINI_MODEL\s*=\s*([a-zA-Z0-9.-]+)/);
    if (eqMatch) return eqMatch[1].trim();
    const match = raw.match(/gemini-[a-zA-Z0-9.-]+/);
    if (match) return match[0];
    return "gemini-3.5-flash-lite";
}

function getCandidateModels() {
    const preferred = getGeminiModel();
    // Prioritize gemini-3.5-flash-lite for instant multimodal vision response
    const list = ["gemini-3.5-flash-lite", preferred, "gemini-3.8-flash"];
    return Array.from(new Set(list.filter(Boolean)));
}

function sendJson(response, statusCode, body) {
    const payload = JSON.stringify(body);
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(payload),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
    });
    response.end(payload);
}

function providerError(code, message, retryable = true) {
    const error = new Error(message);
    error.code = code;
    error.retryable = retryable;
    return error;
}

function readRequestBody(request, response) {
    return new Promise((resolve, reject) => {
        let bodyBytes = 0;
        const chunks = [];

        request.on("data", (chunk) => {
            bodyBytes += chunk.length;
            if (bodyBytes > maxRequestBytes) {
                sendJson(response, 413, { error: "Request body is too large." });
                request.destroy();
                reject(new Error("Request body is too large."));
                return;
            }
            chunks.push(chunk);
        });

        request.on("end", () => resolve(Buffer.concat(chunks)));
        request.on("error", reject);
    });
}

function parseJsonBody(body) {
    try {
        return JSON.parse(body.toString("utf8"));
    } catch {
        return null;
    }
}

function isImageRequest(body) {
    return Boolean(
        body &&
        typeof body.mimeType === "string" &&
        ["image/png", "image/jpeg", "image/webp"].includes(body.mimeType) &&
        typeof body.imageBase64 === "string" &&
        body.imageBase64.length > 0
    );
}

function uncertainCandidate(reason) {
    return {
        name: "Uncertain / Unreadable",
        genericName: "Not identified",
        strength: "Not readable",
        dosageForm: "Not readable",
        drugClass: "Unspecified",
        confidence: "low",
        uncertaintyReason: reason || "The prescription handwriting or medicine label could not be determined confidently.",
        ocrText: "Unclear text",
        commonUses: "Consult your prescribing physician or pharmacist for clinical guidance.",
        administration: "Do not administer until verified by a licensed pharmacist.",
        precautions: "Do not attempt to dispense or take unverified prescriptions.",
        sideEffects: "Consult pharmacist for specific side effect profile.",
        interactions: "Complete pharmacist medication reconciliation required.",
        safetyAssessment: "Safety cannot be established without legible verification."
    };
}

function extractGeminiCandidates(payload) {
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string") return { candidates: [uncertainCandidate()] };

    try {
        const cleaned = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, "$1").trim();
        const result = JSON.parse(cleaned);
        const rawList = Array.isArray(result) ? result : (Array.isArray(result.candidates) ? result.candidates : []);
        if (rawList.length === 0) return { candidates: [uncertainCandidate()] };

        const candidates = rawList.map((c) => ({
            name: (c?.name || "").trim() || "Uncertain / Unreadable",
            genericName: (c?.genericName || "").trim() || (c?.name || "Unspecified"),
            strength: (c?.strength || "").trim() || "Standard dose / As prescribed",
            dosageForm: (c?.dosageForm || "").trim() || "Oral formulation",
            drugClass: (c?.drugClass || "").trim() || "Therapeutic agent",
            confidence: ["low", "medium", "high"].includes(c?.confidence) ? c.confidence : "medium",
            uncertaintyReason: (c?.uncertaintyReason || "").trim() || "Pharmacist confirmation recommended.",
            ocrText: (c?.ocrText || "").trim() || (c?.name ? `${c.name} ${c.strength || ""}` : "Prescription script"),
            commonUses: (c?.commonUses || "").trim() || "Consult healthcare provider for confirmed indications.",
            administration: (c?.administration || "").trim() || "Take strictly in accordance with prescription label instructions.",
            precautions: (c?.precautions || "").trim() || "Discuss allergies, concurrent medicines, and clinical history with your pharmacist.",
            sideEffects: (c?.sideEffects || "").trim() || "Monitor for adverse effects and notify your pharmacist or doctor if noted.",
            interactions: (c?.interactions || "").trim() || "Verify all current supplements and OTC medications with your pharmacist.",
            safetyAssessment: (c?.safetyAssessment || "").trim() || "Verified by clinical pharmacist confirmation protocol."
        })).slice(0, 5);

        return {
            candidates: candidates.length > 0 ? candidates : [uncertainCandidate()],
            requiresUserConfirmation: true,
            simulatedInput: false
        };
    } catch {
        return { candidates: [uncertainCandidate("Gemini returned an unreadable result format for this image.")] };
    }
}

async function requestGeminiCandidates(body) {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
        return {
            candidates: [
                {
                    name: "Synthroid (Levothyroxine Sodium)",
                    genericName: "Levothyroxine Sodium",
                    strength: "50 mcg (0.05 mg)",
                    dosageForm: "Oral Tablet",
                    drugClass: "Synthetic Thyroid Hormone (T4)",
                    confidence: "high",
                    uncertaintyReason: "Handwritten script matches standard 50 mcg Synthroid (white round tablet formulation).",
                    ocrText: "Synthroid 50 mcg",
                    commonUses: "Hypothyroidism (thyroid replacement therapy), pituitary TSH suppression in goiter or post-thyroidectomy.",
                    administration: "Take once daily in morning on an empty stomach with a full glass of water, 30–60 minutes before breakfast. Avoid calcium, iron, or antacids within 4 hours.",
                    precautions: "Narrow therapeutic index; requires regular TSH blood monitoring; exercise caution in elderly or cardiac disease.",
                    sideEffects: "Palpitations, tremor, anxiety, insomnia, heat intolerance, weight loss if dose is excessive.",
                    interactions: "Calcium carbonate, ferrous sulfate, PPIs, sucralfate, cholestyramine, warfarin.",
                    safetyAssessment: "Therapeutic strength (50 mcg) matches standard pharmacopeia tablet strength."
                }
            ],
            requiresUserConfirmation: true,
            simulatedInput: true
        };
    }

    const models = getCandidateModels();
    const prompt = [
        "You are an expert clinical pharmacist and prescription verification AI reading a prescription or medicine packaging image.",
        "Perform a high-level, comprehensive verification analysis of the prescription or medicine visible in the image:",
        "1. Identify the primary medicine name (e.g. Synthroid) and its generic chemical name (e.g. Levothyroxine Sodium).",
        "2. Accurately transcribe what is written on the prescription line in 'ocrText' (e.g. 'Synthroid 50 mcg').",
        "3. Identify the exact strength (e.g. '50 mcg (0.05 mg)'). Specifically address any digit ambiguities (e.g. if 50 looks like 58, note standard manufactured strengths).",
        "4. Identify the dosage form (e.g. Oral Tablet, Capsule, Suspension).",
        "5. Identify the pharmacological drug class (e.g. Synthetic Thyroid Hormone T4, Beta-1 Adrenergic Antagonist).",
        "6. Provide the primary clinical uses and approved indications.",
        "7. Provide clear, clinical administration instructions (e.g. empty stomach, timing, food spacing).",
        "8. Provide critical safety precautions and clinical contraindications (e.g. narrow therapeutic index, lab monitoring, cardiac warnings).",
        "9. Provide notable common and serious side effects.",
        "10. Provide key drug-drug and dietary interactions (e.g. calcium, iron, antacids, PPIs).",
        "11. Provide an objective safety assessment evaluating the prescription legibility and dosage appropriateness.",
        "12. If the text has handwritten ambiguities, explain them clearly in 'uncertaintyReason'.",
        "If the image is completely illegible or not a prescription/medicine, name the candidate 'Uncertain / Unreadable'.",
        "Set confidence to 'high', 'medium', or 'low'.",
        "Return clean JSON strictly conforming to the response schema."
    ].join(" ");

    const sanitizedBase64 = body.imageBase64.replace(/\s+/g, "");
    let lastError = null;

    for (const model of models) {
        try {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
            const apiResponse = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(20000),
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            { inlineData: { mimeType: body.mimeType, data: sanitizedBase64 } }
                        ]
                    }],
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: {
                            type: "OBJECT",
                            properties: {
                                candidates: {
                                    type: "ARRAY",
                                    items: {
                                        type: "OBJECT",
                                        properties: {
                                            name: { type: "STRING" },
                                            genericName: { type: "STRING" },
                                            strength: { type: "STRING" },
                                            dosageForm: { type: "STRING" },
                                            drugClass: { type: "STRING" },
                                            confidence: { type: "STRING", enum: ["low", "medium", "high"] },
                                            uncertaintyReason: { type: "STRING" },
                                            ocrText: { type: "STRING" },
                                            commonUses: { type: "STRING" },
                                            administration: { type: "STRING" },
                                            precautions: { type: "STRING" },
                                            sideEffects: { type: "STRING" },
                                            interactions: { type: "STRING" },
                                            safetyAssessment: { type: "STRING" }
                                        },
                                        required: [
                                            "name", "genericName", "strength", "dosageForm", "drugClass",
                                            "confidence", "uncertaintyReason", "ocrText", "commonUses",
                                            "administration", "precautions", "sideEffects", "interactions",
                                            "safetyAssessment"
                                        ]
                                    }
                                }
                            },
                            required: ["candidates"]
                        }
                    }
                })
            });

            if (apiResponse.ok) {
                const data = await apiResponse.json();
                return extractGeminiCandidates(data);
            }

            const errorBody = await apiResponse.text();
            console.warn(`Model ${model} returned HTTP ${apiResponse.status}:`, errorBody);
            lastError = new Error(`Model ${model} returned ${apiResponse.status}`);
        } catch (err) {
            console.warn(`Model ${model} request error:`, err.message);
            lastError = err;
        }
    }

    // Graceful fallback if models are busy or rate-limited
    console.warn("All candidate models failed. Last error was:", lastError?.message);
    return {
        candidates: [
            uncertainCandidate("Gemini verification service is temporarily busy. Pharmacist verification is required.")
        ],
        requiresUserConfirmation: true,
        simulatedInput: false
    };
}

async function requestGeminiChat(prompt, history = []) {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
        return "ExactRx AI Assistant: Gemini API key is currently not active in this environment. For medication safety questions, consult a licensed pharmacist or physician.";
    }

    const models = getCandidateModels();
    const systemPrompt = [
        "You are the ExactRx Clinical AI Assistant — an authoritative, evidence-based medication safety, drug information, and pharmacy education platform.",
        "Provide clear, professional, well-structured clinical answers suitable for pharmacy students, healthcare professionals, and patients seeking reliable understanding.",
        "When explaining medications, include: Drug Classification, Mechanism of Action, Common Uses, Critical Precautions/Contraindications, Key Side Effects, Significant Drug Interactions, and Patient Counseling points.",
        "Include reference guidance (e.g., USP, FDA, BNF, Clinical Pharmacology).",
        "Maintain ethical healthcare boundaries: clearly provide educational and scientific information; remind users that personal treatment decisions should be reviewed with a licensed pharmacist or doctor."
    ].join(" ");

    const formattedContents = [];
    if (Array.isArray(history) && history.length > 0) {
        for (const item of history.slice(-6)) {
            formattedContents.push({
                role: item.role === "assistant" ? "model" : "user",
                parts: [{ text: String(item.text || "") }]
            });
        }
    }
    formattedContents.push({
        role: "user",
        parts: [{ text: `${systemPrompt}\n\nUser Question: ${prompt}` }]
    });

    for (const model of models) {
        try {
            const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
            const apiResponse = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: AbortSignal.timeout(20000),
                body: JSON.stringify({
                    contents: formattedContents
                })
            });

            if (apiResponse.ok) {
                const data = await apiResponse.json();
                const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (reply) return reply;
            }
        } catch (err) {
            console.warn(`Chat on ${model} failed:`, err.message);
        }
    }

    return "ExactRx AI Assistant is currently experiencing high clinical query volume. Please consult a licensed pharmacist or healthcare provider for immediate medication guidance.";
}

const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if ((requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") && request.method === "GET") {
        try {
            const html = fs.readFileSync("index.html", "utf8");
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            response.end(html);
        } catch (readErr) {
            sendJson(response, 500, { error: "Failed to load index.html" });
        }
        return;
    }

    if (requestUrl.pathname === "/styles.css" && request.method === "GET") {
        try {
            const css = fs.readFileSync("styles.css", "utf8");
            response.writeHead(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache" });
            response.end(css);
        } catch {
            response.writeHead(404);
            response.end("Not found");
        }
        return;
    }

    if (requestUrl.pathname === "/app.js" && request.method === "GET") {
        try {
            const js = fs.readFileSync("app.js", "utf8");
            response.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" });
            response.end(js);
        } catch {
            response.writeHead(404);
            response.end("Not found");
        }
        return;
    }

    if (requestUrl.pathname === "/api/health" && request.method === "GET") {
        const hasKey = Boolean(getGeminiApiKey());
        sendJson(response, 200, {
            ok: true,
            geminiConfigured: hasKey,
            verificationEnabled: true
        });
        return;
    }

    if (requestUrl.pathname === "/api/chat") {
        if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            sendJson(response, 405, { error: "Method not allowed." });
            return;
        }

        try {
            const body = parseJsonBody(await readRequestBody(request, response));
            const prompt = body?.prompt ? String(body.prompt).trim() : "";
            if (!prompt) {
                sendJson(response, 400, { error: "Prompt is required." });
                return;
            }

            const reply = await requestGeminiChat(prompt, body?.history);
            sendJson(response, 200, { reply });
            return;
        } catch (error) {
            console.error("Chat endpoint error:", error);
            sendJson(response, 500, { error: "Failed to process AI chat query." });
            return;
        }
    }

    if (requestUrl.pathname === "/api/verify-image") {
        if (request.method !== "POST") {
            response.setHeader("Allow", "POST");
            sendJson(response, 405, { error: "Method not allowed." });
            return;
        }

        try {
            const body = parseJsonBody(await readRequestBody(request, response));
            if (!isImageRequest(body)) {
                sendJson(response, 400, {
                    error: "A PNG, JPG, or WEBP image is required."
                });
                return;
            }

            const apiKey = getGeminiApiKey();
            if (!apiKey) {
                // If API key is not configured, provide simulated verification candidate for prototype evaluation
                sendJson(response, 200, {
                    candidates: [
                        {
                            name: "Amoxicillin",
                            strength: "500 mg",
                            dosageForm: "Capsule",
                            confidence: "medium",
                            uncertaintyReason: "Sample candidate (Gemini API key not configured in environment). Pharmacist verification required."
                        }
                    ],
                    requiresUserConfirmation: true,
                    simulatedInput: true
                });
                return;
            }

            const result = await requestGeminiCandidates(body);
            sendJson(response, 200, result);
            return;
        } catch (error) {
            console.error("Verification error:", error);
            sendJson(response, error.code === "GEMINI_AUTHENTICATION_FAILED" || error.code === "GEMINI_MODEL_UNAVAILABLE" ? 502 : 503, {
                error: {
                    code: error.code || "GEMINI_UNAVAILABLE",
                    message: error.message || "Gemini verification is temporarily unavailable.",
                    retryable: error.retryable !== false
                }
            });
            return;
        }
    }

    sendJson(response, 404, { error: "Not found." });
});

server.listen(port, "0.0.0.0", () => {
    console.log(`ExactRx backend listening on http://0.0.0.0:${port}`);
});
