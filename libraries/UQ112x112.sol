//SPDX-License-Identifier: None
pragma solidity ^0.8.0;

// a library for handling binary fixed point numbers (https://en.wikipedia.org/wiki/Q_(number_format))
// range: [0, 2**112 - 1]
// resolution: 1 / 2**112
library UQ112x112 {
    uint224 constant Q112 = 2**112;
    uint224 constant Q224 = 2**224 - 1;

    // encode a uint112 as a UQ112x112
    function encode(uint112 y) internal pure returns (uint224 z) {
        z = uint224(y) * Q112; // never overflows
    }

    // divide a UQ112x112 by a uint112, returning a UQ112x112
    function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
        z = x / uint224(y);
    }

    // divide a UQ112x112 by a UQ112x112, returning a UQ112x112
    function div(uint224 x, uint224 y) internal pure returns (uint224 z) {
        unchecked {
            require (y != 0);
            // xDec = x & 2**112-1 i.e 112 precision 112 bits of padding on the left
            uint224 xDec = x & 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFF;
             //xInt x *2**-112 i.e. 112 precision 112 bits of padding on the right
            uint224 xInt = x >> 112;
            //hi = xInt*2**224-1 /y ==> leave a full uint224 of bits to store the integer representation of the fractional decimal with 112.112 precision
            uint224 hi = xInt * (Q224 / y);
            //lo = xDec*2**224-1 /y ==> leave full uint224 of bits to store the integer representation of fractional decimal with 112.112 precision, right shift 112 bits since output should be the right 112 bits of precision on the output
            uint224 lo = (xDec * (Q224 / y)) >> 112;

            require (hi <= Q224 - lo);
            return hi+lo;
        }
    }

    // Computes x * y where x is a Q126.2 fixed point number and y is an unsigned integer, rounding down to the nearest integer.
    function mul126_2x256(uint128 x, uint256 y) internal pure returns (uint256) {
        unchecked {
            if (y == 0) return 0;

            uint256 lo = (uint256(x) *
                (y & 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF)) >> 2; //last 128 bits of y, right shift 2 bits to remove the 2 decimal bits at the end
            uint256 hi = uint256(x) * (y >> 128); //first 128 bits of y

            require(hi <= 0x3FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF); //2^254 - 1
            hi <<= 2; //left shift 2 bits to account for the 2 decimal bits in x

            require(
                hi <=
                    0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF -
                        lo
            ); //ensure hi + lo does not overflow
            return hi + lo;
        }
    }

    //computes x * y where x is a Q126.2 fixed point number and y is a Q112.112 fixed point number, returning a Q112.112 fixed point number
    function mul126_2x112_112(uint128 x, uint224 y) internal pure returns (uint224) {
        unchecked {
            uint256 result = (uint256(x) * y) >> 2;
            require(result <= Q224);
            return uint224(result);
        }
    }
    
}