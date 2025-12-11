import axios from "axios";
import { getAccessToken } from "../config/store";
import { loadEnv } from "../config/env";
import { PrismaClient } from "@prisma/client";
import { rateLimiter } from "../utils/rateLimiter";
import { processGapData } from "./gapAlertService";

loadEnv();

const prisma = new PrismaClient();

type InstrumentLeg = {
    symbolId: number;
    instrumentId: number;
    instrumentType: string;
    name: string;
    expiry_date: Date;
    leg: "near" | "next" | "far";
};

type SymbolInstruments = {
    symbolId: number;
    instruments: InstrumentLeg[];
};

/**
 * Fetch NSE FUT instruments grouped as near/next/far legs per symbol
 * (Reusing logic from hourly job but keeping it independent)
 */
async function getNseInstruments(): Promise<SymbolInstruments[]> {
    try {
        const instruments = await prisma.$queryRaw<
            Array<{
                symbolid: number;
                name: string;
                instrumentid: number;
                instrument_type: string;
                expiry_date: Date;
            }>
        >`
      select sl.instrument_id as symbolId, 
        il.instrument_type as name, 
        sl.id as instrumentId, 
        sl.symbol as instrument_type, 
        sl.expiry_date
      from market_data.symbols_list sl
      inner join market_data.instrument_lists il on il.id = sl.instrument_id 
      where expiry_date >= CURRENT_DATE and segment = 'FUT'
      order by symbolId asc, expiry_date asc
    `;

        const grouped = new Map<number, InstrumentLeg[]>();
        instruments.forEach((instrument) => {
            const list = grouped.get(instrument.symbolid) || [];
            list.push({
                symbolId: instrument.symbolid,
                instrumentId: instrument.instrumentid,
                instrumentType: instrument.instrument_type,
                name: instrument.name,
                expiry_date: instrument.expiry_date,
                leg: "near",
            });
            grouped.set(instrument.symbolid, list);
        });

        const symbolInstruments: SymbolInstruments[] = [];
        const legOrder: InstrumentLeg["leg"][] = ["near", "next", "far"];
        grouped.forEach((list, symbolId) => {
            const sorted = list
                .sort((a, b) => a.expiry_date.getTime() - b.expiry_date.getTime())
                .slice(0, 3)
                .map((item, index) => ({
                    ...item,
                    leg: legOrder[index] ?? "far",
                }));

            if (sorted.length >= 1) {
                symbolInstruments.push({ symbolId, instruments: sorted });
            }
        });

        return symbolInstruments;
    } catch (error: any) {
        console.error("? Failed to fetch NSE Futures instruments:", error.message);
        return [];
    }
}

function transformRecordsToDbFormat(
    records: any[],
    instrumentId: number
): any[] {
    const now = new Date();
    return records.map((record) => ({
        instrumentId: instrumentId,
        ltp: record[1].toString(),
        volume: record[2].toString(),
        oi: record[3].toString(),
        bid: record[4].toString(),
        bidqty: record[5].toString(),
        ask: record[6].toString(),
        askqty: record[7].toString(),
        time: new Date(record[0]),
        updatedAt: now,
    }));
}

async function bulkInsertTicksData(records: any[]): Promise<number> {
    try {
        const result = await prisma.ticksDataNSEFUT.createMany({
            data: records,
            skipDuplicates: true,
        });
        return result.count;
    } catch (error: any) {
        console.error(`? Failed to bulk insert ticks data:`, error.message);
        return 0;
    }
}

/**
 * Backfill gaps for a specific date by randomly sampling 30 aligned data points
 * @param dateInput Date string (YYYY-MM-DD) or Date object
 */
export async function backfillGapsForDate(dateInput: string | Date): Promise<void> {
    const dateObj = new Date(dateInput);
    const dateStr = dateObj.toISOString().slice(2, 10).replace(/-/g, ""); // YYMMDD
    // e.g. 2024-12-09 -> 241209

    const accessToken = getAccessToken();
    if (!accessToken) {
        console.error("? No access token available for backfill");
        return;
    }

    console.log(`?? Starting backfill for date: ${dateInput} (Format: ${dateStr})`);

    const symbols = await getNseInstruments();
    const MIN_VOLUME_THRESHOLD = Number(process.env.MIN_VOLUME_THRESHOLD) || 10;
    const MIN_TIME_DIFF = 15 * 1000; // 15 seconds

    for (const symbol of symbols) {
        const legData: Record<string, any[]> = {};

        // 1. Fetch full day data for all legs
        for (const leg of symbol.instruments) {
            try {
                await rateLimiter.waitForSlot();
                const url = `https://history.truedata.in/getticks?symbol=${leg.instrumentType}&bidask=1&from=${dateStr}T09:00:00&to=${dateStr}T15:30:00&response=json`;

                try {
                    const response = await axios.get(url, {
                        headers: { Authorization: `Bearer ${accessToken}` },
                    });

                    if (response.data && response.data.status === "Success" && response.data.Records) {
                        legData[leg.leg] = response.data.Records;
                    } else {
                        // console.warn(`No data for ${leg.instrumentType}`);
                    }
                } catch (err: any) {
                    console.error(`Error fetching ${leg.instrumentType}: ${err.message}`);
                }

            } catch (error: any) {
                console.error(`? Failed to fetch data for ${leg.instrumentType}:`, error.message);
            }
        }

        // 2. Align data points
        // We need at least 'near' and 'next' for Gap 1, and 'next' and 'far' for Gap 2.
        // Ideally we find points where all 3 exist, or at least pairs.
        // For simplicity, let's drive off the 'Near' leg (most liquid usually).

        if (!legData.near || legData.near.length === 0) continue;

        const alignedPoints: any[] = [];

        // Sort all legs by time just in case
        const nearRecs = legData.near;
        const nextRecs = legData.next || [];
        const farRecs = legData.far || [];

        // Helper to find closest record within 15s
        const findClosest = (targetTime: number, records: any[]) => {
            // Simple linear search or binary search. Given 6.5 hours of ticks, linear might be slow if huge volume.
            // But for a backfill script, simple is safer. Optimization: binary search.
            // Let's implement a simple binary search for efficiency.
            let low = 0;
            let high = records.length - 1;
            let bestIdx = -1;
            let minDiff = Infinity;

            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const recTime = new Date(records[mid][0]).getTime();
                const diff = Math.abs(recTime - targetTime);

                if (diff < minDiff) {
                    minDiff = diff;
                    bestIdx = mid;
                }

                if (recTime < targetTime) {
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }

            if (bestIdx !== -1 && minDiff <= MIN_TIME_DIFF) {
                return records[bestIdx];
            }
            return null;
        };

        // Iterate Near records and find matches
        // Data reduction: Iterate every Nth record to save time? Or check all?
        // Let's check all but maybe skip if we have massive amount.
        for (let i = 0; i < nearRecs.length; i++) {
            const nearRec = nearRecs[i];
            const nearTime = new Date(nearRec[0]).getTime();
            const nearVol = Number(nearRec[2]);

            if (nearVol < MIN_VOLUME_THRESHOLD) continue;

            const nextRec = findClosest(nearTime, nextRecs);
            const farRec = findClosest(nearTime, farRecs);

            // We need at least one gap valid
            let validGap1 = false;
            let validGap2 = false;

            if (nextRec && Number(nextRec[2]) >= MIN_VOLUME_THRESHOLD) {
                validGap1 = true;
            }

            // Gap 2 needs Next & Far. 
            if (nextRec && farRec && Number(nextRec[2]) >= MIN_VOLUME_THRESHOLD && Number(farRec[2]) >= MIN_VOLUME_THRESHOLD) {
                // For Gap 2 we specifically check time diff between Next and Far.
                // findClosest checked Near vs Next, and Near vs Far.
                // We implicitly trust that if Near~Next and Near~Far, then Next~Far is likely close (triangle inequality), 
                // but let's be strict if needed. 
                // Math.abs(next - far) <= min_diff
                if (Math.abs(new Date(nextRec[0]).getTime() - new Date(farRec[0]).getTime()) <= MIN_TIME_DIFF) {
                    validGap2 = true;
                }
            }

            if (validGap1 || validGap2) {
                alignedPoints.push({
                    near: nearRec,
                    next: nextRec,
                    far: farRec
                });
            }
        }

        // 3. Randomly sample 30
        const samples = [];
        if (alignedPoints.length <= 30) {
            samples.push(...alignedPoints);
        } else {
            // Shuffle and pick 30
            for (let i = alignedPoints.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [alignedPoints[i], alignedPoints[j]] = [alignedPoints[j], alignedPoints[i]];
            }
            samples.push(...alignedPoints.slice(0, 30));
        }

        console.log(`? ${symbol.instruments[0]?.name || symbol.symbolId}: Found ${alignedPoints.length} aligned points. Selected ${samples.length}.`);

        if (samples.length === 0) continue;

        // 4. Process and Insert
        const ticksToInsert: any[] = [];
        const gapsToProcess: any[] = [];

        for (const sample of samples) {
            // Collect ticks for DB insertion
            if (sample.near) ticksToInsert.push(...transformRecordsToDbFormat([sample.near], symbol.instruments.find(i => i.leg === 'near')!.instrumentId));
            if (sample.next) ticksToInsert.push(...transformRecordsToDbFormat([sample.next], symbol.instruments.find(i => i.leg === 'next')!.instrumentId));
            if (sample.far) ticksToInsert.push(...transformRecordsToDbFormat([sample.far], symbol.instruments.find(i => i.leg === 'far')!.instrumentId));

            // Calculate Gaps
            let gap_1: number | null = null;
            let gap_2: number | null = null;
            let price_1 = sample.near ? Number(sample.near[1]) : undefined;
            let price_2 = sample.next ? Number(sample.next[1]) : undefined;
            let price_3 = sample.far ? Number(sample.far[1]) : undefined;

            let timestamp = new Date(sample.near[0]); // Default to near time

            // Gap 1
            if (sample.near && sample.next) {
                gap_1 = Number(sample.next[1]) - Number(sample.near[1]);
                timestamp = new Date(Math.max(new Date(sample.near[0]).getTime(), new Date(sample.next[0]).getTime()));
            }

            // Gap 2
            if (sample.next && sample.far) {
                gap_2 = Number(sample.far[1]) - Number(sample.next[1]);
                timestamp = new Date(Math.max(timestamp.getTime(), new Date(sample.next[0]).getTime(), new Date(sample.far[0]).getTime()));
            }

            gapsToProcess.push({
                instrumentId: symbol.symbolId,
                instrumentName: symbol.instruments[0].name,
                gap_1,
                gap_2,
                price_1,
                price_2,
                price_3,
                timestamp,
                // timeSlot will be auto-calculated by processGapData from timestamp
            });
        }

        // Bulk insert ticks
        if (ticksToInsert.length > 0) {
            await bulkInsertTicksData(ticksToInsert);
        }

        // Process gaps (store + suppress alert)
        if (gapsToProcess.length > 0) {
            await processGapData(gapsToProcess, { suppressAlerts: true });
        }
    }

    console.log("?? Backfill completed.");
}
