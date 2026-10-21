import { useParams } from 'react-router-dom';
import { ShiftDetailLoader } from '@/sales/ShiftDetailLoader';

export function SalesShiftPage() {
  const { shiftId = '' } = useParams();
  return <ShiftDetailLoader shiftId={shiftId} />;
}
