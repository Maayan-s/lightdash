export type PersonalAccessToken = {
    uuid?: string;
    createdAt: Date;
    expiresAt?: Date;
    description: string;
};

export type ApiPersonalAccessTokenResponse = {
    uuid?: string;
    createdAt: string;
    expiresAt?: string;
    description: string;
};

export type CreatePersonalAccessToken = Pick<
    PersonalAccessToken,
    'expiresAt' | 'description'
>;
