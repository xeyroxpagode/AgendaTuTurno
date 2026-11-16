import { InventoryWorkspace } from "@/features/inventory/InventoryWorkspace";
import { Suspense } from "react";
export default function SuppliesPage(){return <Suspense fallback={<p role="status">Cargando insumos…</p>}><InventoryWorkspace supplies/></Suspense>;}
