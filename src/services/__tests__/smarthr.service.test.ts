import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmartHRService } from '../smarthr.service';
import type { SmartHRConfig, SmartHRCrew } from '../../types/smarthr.types';

// Mock fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const mockConfig: SmartHRConfig = {
  baseUrl: 'https://acg.smarthr.jp/api/v1',
  accessToken: 'test-token-123',
};

const mockCrew1: SmartHRCrew = {
  id: 'crew-001',
  emp_code: 'EMP001',
  last_name: '山田',
  first_name: '太郎',
  last_name_yomi: 'ヤマダ',
  first_name_yomi: 'タロウ',
  department: { id: 'dept-001', name: '訪問看護部' },
};

const mockCrew2: SmartHRCrew = {
  id: 'crew-002',
  emp_code: 'EMP002',
  last_name: '鈴木',
  first_name: '花子',
  last_name_yomi: 'スズキ',
  first_name_yomi: 'ハナコ',
};

function createMockResponse(data: unknown, totalCount: number, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: {
      get: (key: string) => key === 'x-total-count' ? String(totalCount) : null,
    },
    json: () => Promise.resolve(data),
  };
}

describe('SmartHRService', () => {
  let service: SmartHRService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SmartHRService(mockConfig);
  });

  describe('getAllCrews', () => {
    it('fetches all crews from a single page', async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse([mockCrew1, mockCrew2], 2)
      );

      const crews = await service.getAllCrews();

      expect(crews).toHaveLength(2);
      expect(crews[0].emp_code).toBe('EMP001');
      expect(crews[1].emp_code).toBe('EMP002');
    });

    it('fetches all crews across multiple pages', async () => {
      // Page 1: 1 crew, total=2
      mockFetch.mockResolvedValueOnce(
        createMockResponse([mockCrew1], 2)
      );
      // Page 2: 1 crew, total=2
      mockFetch.mockResolvedValueOnce(
        createMockResponse([mockCrew2], 2)
      );

      const crews = await service.getAllCrews();

      expect(crews).toHaveLength(2);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('sends correct Authorization header', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse([], 0));

      await service.getAllCrews();

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/crews'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token-123',
          }),
        })
      );
    });

    it('throws on API error', async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(null, 0, 401));

      await expect(service.getAllCrews()).rejects.toThrow('SmartHR API エラー: 401');
    });
  });

  describe('toStaffMasterEntry', () => {
    it('maps crew to staff master entry correctly', () => {
      const entry = service.toStaffMasterEntry(mockCrew1);

      expect(entry.staffNumber).toBe('EMP001');
      expect(entry.staffName).toBe('山田 太郎');
      expect(entry.staffNameLegal).toBe('山田 太郎');
      expect(entry.staffNameYomi).toBe('ヤマダ タロウ');
      expect(entry.qualifications).toEqual([]);
    });

    it('prefers business name over legal name', () => {
      const crewWithBizName: SmartHRCrew = {
        ...mockCrew1,
        business_last_name: '田中',
        business_first_name: '次郎',
      };

      const entry = service.toStaffMasterEntry(crewWithBizName);
      expect(entry.staffName).toBe('田中 次郎');
      expect(entry.staffNameLegal).toBe('山田 太郎');
    });

    it('handles missing yomi fields gracefully', () => {
      const crewNoYomi: SmartHRCrew = {
        ...mockCrew1,
        last_name_yomi: '',
        first_name_yomi: '',
      };

      const entry = service.toStaffMasterEntry(crewNoYomi);
      expect(entry.staffNameYomi).toBe('');
    });
  });
});
