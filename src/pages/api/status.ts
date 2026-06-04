
import { getScanStatus, db } from '../../lib/db';

export async function GET() {
    const status = getScanStatus();

    let count = 0;
    try {
        const result = db.query("SELECT COUNT(*) as c FROM items").get() as any;
        count = result ? result.c : 0;
    } catch (e) {
        console.error("Failed to get count", e);
    }

    return new Response(JSON.stringify({
        ...status,
        totalItems: count
    }), {
        headers: { "Content-Type": "application/json" }
    });
}
