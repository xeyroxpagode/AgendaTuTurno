import { InventoryWorkspace } from "@/features/inventory/InventoryWorkspace";
import { Suspense } from "react";
export default function InventoryPage(){return <Suspense fallback={<p role="status">Cargando inventario…</p>}><InventoryWorkspace/></Suspense>;}
